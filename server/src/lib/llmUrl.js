/* 用户自定义的模型 Base URL —— 校验
 *
 * ── 为什么要这个文件 ──────────────────────────────────────────────
 * 「模型接入」允许用户自己填 Base URL，而**服务端会拿这个地址发请求**。
 * 这在单机自用场景下完全正常，但只要站点开放注册，它就变成一台
 * 免费的 SSRF 跳板：任何注册用户都能把地址填成内网服务，
 * 然后从接口的响应体里把内网内容读出来。
 *
 * 实测过的攻击路径（修之前）：
 *   1. 注册一个账号（当时没有邀请码）
 *   2. PUT /api/settings/llm  { cloudBase: "http://127.0.0.1:55371" }
 *   3. POST /api/settings/llm/test
 *      → 响应体里带着那个内网服务返回的原文
 *   指向 169.254.169.254（云元数据）时请求也确实发出去了 ——
 *   在真云主机上那是拿临时凭据的经典入口。
 *
 * ── 策略 ────────────────────────────────────────────────────────
 *   环回地址（127.0.0.0/8、::1）      → **放行**。本地模型（LM Studio / Ollama）
 *                                        就靠它，而且环回不是内网横向移动的跳板。
 *   其它私有 / 保留 / 链路本地地址      → **默认拒绝**。这些才是 SSRF 的价值所在，
 *                                        169.254.169.254 也在其中。
 *   公网地址                          → 放行；云端模型额外要求 https
 *                                        （明文把 API Key 发出去是不行的）。
 *
 * 想让模型跑在同一局域网的另一台机器上（比如台式机跑 Ollama、笔记本用），
 * 设 `ALLOW_PRIVATE_LLM_HOST=1` 打开私有网段。这是一个明确的取舍，
 * 所以做成显式开关而不是默认行为。
 *
 * ── 残留风险（写清楚，免得以后以为万无一失）──────────────────────
 * 这里解析域名拿到 IP 再判断，判断完却仍然用**域名**去发请求 ——
 * 理论上存在 DNS rebinding（第一次解析返回公网 IP 通过校验，
 * 真正发请求时解析到内网 IP）。彻底堵住要把解析结果钉住再连，
 * 那需要自定义 dispatcher，代价和收益不成比例。
 * 现在的防线是「写入时校验 + 不跟随重定向 + 控制注册」，
 * 对一个自学系统是够的；真开放给陌生人用，应该先把注册关掉。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** IPv4 私有 / 保留网段。写成 [起始地址, 前缀长度]。 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // 「本网络」
  ['10.0.0.0', 8],       // 私有
  ['100.64.0.0', 10],    // CGNAT
  ['169.254.0.0', 16],   // 链路本地 —— 云元数据 169.254.169.254 在这里
  ['172.16.0.0', 12],    // 私有
  ['192.0.0.0', 24],     // IETF 协议分配
  ['192.168.0.0', 16],   // 私有
  ['198.18.0.0', 15],    // 基准测试
  ['224.0.0.0', 4],      // 组播
  ['240.0.0.0', 4],      // 保留（含 255.255.255.255）
];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);

function isBlockedV4(ip) {
  const v = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (v & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
  });
}

/** 环回单独判 —— 它不在 BLOCKED_V4 里，是**有意放行**的那一类。 */
function isLoopbackV4(ip) {
  return (v4ToInt(ip) & 0xff000000) >>> 0 === v4ToInt('127.0.0.0');
}

/**
 * IPv6 判断。只做保守处理：只认环回和「明显是私有 / 链路本地 / 未指定」的，
 * 其余一律当公网放行 —— 漏判比误杀好，因为公网 IPv6 地址形态太多，
 * 用正则去枚举只会把正常地址也拒掉。
 */
function isLoopbackV6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s === '0:0:0:0:0:0:0:1';
}

function isBlockedV6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '0:0:0:0:0:0:0:0') return true;       // 未指定
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return true;     // fc00::/7 唯一本地
  if (s.startsWith('ff')) return true;                           // 组播
  // IPv4 映射地址 ::ffff:1.2.3.4 —— 拆出来按 v4 规则判
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isBlockedV4(m[1]) || isLoopbackV4(m[1]);
  return false;
}

/**
 * 校验一个用户填的 Base URL。
 *
 * @param {string} raw  用户输入
 * @param {{ forCloud?: boolean }} [opts] forCloud=true 时要求 https（明文发密钥不可接受）
 * @returns {Promise<string|null>} null = 通过；否则返回给用户看的错误文案
 */
export async function checkLlmBase(raw, { forCloud = false } = {}) {
  const allowPrivate = process.env.ALLOW_PRIVATE_LLM_HOST === '1';
  const s = String(raw ?? '').trim();
  if (!s) return null;                    // 空值 = 没填，交给原来的「没配模型」提示

  let u;
  try {
    u = new URL(s);
  } catch {
    return 'Base URL 不是合法地址。要形如 https://api.example.com/v1';
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `Base URL 只支持 http / https，当前是 ${u.protocol.replace(':', '')}`;
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');   // 去掉 IPv6 字面量的方括号
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      return `解析不出这个域名：${host}`;
    }
  }
  if (!addrs.length) return `解析不出这个域名：${host}`;

  /* ★ 地址检查要排在「云端必须 https」**之前**。
   *
   * 反过来的话，`http://169.254.169.254` 会得到「必须是 https」这句 ——
   * 技术上没错（确实也得是 https），但它把真正的原因盖住了：
   * 用户会以为换个 https 就行，而实际上这个地址本身就不该被允许。
   * 报错要说最根本的那一条。 */
  for (const a of addrs) {
    const loop = a.family === 6 ? isLoopbackV6(a.address) : isLoopbackV4(a.address);
    if (loop) continue;                              // 环回始终放行（本地模型）
    const blocked = a.family === 6 ? isBlockedV6(a.address) : isBlockedV4(a.address);
    if (blocked && !allowPrivate) {
      return `这个地址指向内网（${a.address}），出于安全考虑不允许。`
        + '如果你的模型确实跑在内网另一台机器上，'
        + '在服务端设 ALLOW_PRIVATE_LLM_HOST=1 再重启。';
    }
  }

  /* 云端那栏额外要求 https：明文把 API Key 发出去是不能接受的。 */
  if (forCloud && u.protocol !== 'https:') {
    return '云端模型的 Base URL 必须是 https —— 用 http 会把 API Key 明文发出去。'
      + '本地模型请在「本地」那一栏填。';
  }

  return null;
}

/**
 * 发往模型上游的请求统一走这里，而不是裸 fetch。
 *
 * 只做一件事：**不跟随重定向**。
 * 一个 `302 → http://169.254.169.254/...` 就能绕过写入时的校验，
 * 所以重定向必须在传输层就掐掉。
 */
export async function llmFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    const e = new Error('模型地址返回了重定向。出于安全考虑不会跟随 —— '
      + '请把 Base URL 直接填成最终地址。');
    e.code = 'LLM_REDIRECT';
    throw e;
  }
  return res;
}

/* 模型输出里的 JSON —— 宽容解析
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 模型吐 JSON 从来不守规矩：包在 ```json 围栏里、前后带一句「好的，我来…」、
 * 对象末尾留个尾逗号。这些情况在四个接口（提取卡片 / 错因归类 / 生成题 /
 * 课堂）里都会遇到，而处理策略必须一致 —— 不一致的话，同一个模型行为
 * 在一个接口里能用、在另一个接口里报错，查起来毫无头绪。
 *
 * ── 为什么返回空值而不是抛异常 ────────────────────────────────────
 * 调用方拿到 []/null 时会走「这次没成功」的分支（返回 parseFailed、
 * 或回退到用户自评）。抛异常则会让整个请求 500，而那本来是一个
 * 可以优雅降级的场景。
 */

/* 模型经常把 JSON 包在 ```json 里，或者前后加一句话 —— 这里宽容地把它抠出来 */
export function parseJsonArray(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 同样的宽容策略，针对对象 */
export function parseJsonObject(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // 模型偶尔会在 JSON 里留尾逗号，兜一次
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

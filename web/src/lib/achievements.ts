/* 成就元数据（与服务端 lib/game.js 的 ACHIEVEMENTS 一一对应）
 * 前端需要它来把「新解锁的 id」翻译成能显示的名字 —— 服务端返回的只有 id。
 */
export interface AchievementMeta {
  id: string;
  name: string;
  desc: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold';
}

export const ACHIEVEMENTS: AchievementMeta[] = [
  { id: 'first-step', name: '万里长征第一步', desc: '完成第一次打卡', icon: '始', tier: 'bronze' },
  { id: 'streak-7', name: '一周不辍', desc: '连续打卡 7 天', icon: '七', tier: 'bronze' },
  { id: 'streak-30', name: '月度铁人', desc: '连续打卡 30 天', icon: '月', tier: 'silver' },
  { id: 'streak-100', name: '百日筑基', desc: '连续打卡 100 天', icon: '百', tier: 'gold' },

  { id: 'learn-10', name: '开卷有益', desc: '学完 10 个知识点', icon: '书', tier: 'bronze' },
  { id: 'learn-30', name: '半壁江山', desc: '学完 30 个知识点', icon: '半', tier: 'silver' },
  { id: 'learn-half', name: '过半', desc: '学完当前考纲一半的知识点', icon: '越', tier: 'silver' },
  { id: 'learn-all', name: '全树点亮', desc: '学完全部知识点', icon: '全', tier: 'gold' },

  { id: 'correct-50', name: '五十题', desc: '累计答对 50 题', icon: '五', tier: 'bronze' },
  { id: 'correct-200', name: '题海遨游', desc: '累计答对 200 题', icon: '海', tier: 'silver' },
  { id: 'correct-500', name: '千锤百炼', desc: '累计答对 500 题', icon: '千', tier: 'gold' },

  { id: 'combo-10', name: '十连对', desc: '单日连续答对 10 题', icon: '十', tier: 'bronze' },
  { id: 'combo-25', name: '势不可挡', desc: '单日连续答对 25 题', icon: '势', tier: 'silver' },
  { id: 'combo-50', name: '无人能挡', desc: '单日连续答对 50 题', icon: '极', tier: 'gold' },

  { id: 'queue-clear', name: '队列清零', desc: '清空一次到期的复习队列', icon: '清', tier: 'bronze' },
  { id: 'mistake-zero', name: '错题清仓', desc: '答对过至少 5 题，且错题本已经清空', icon: '仓', tier: 'silver' },
  { id: 'focus-120', name: '深度专注', desc: '单日专注满 120 分钟', icon: '专', tier: 'silver' },
  { id: 'deck-20', name: '卡片收藏家', desc: '卡片库攒够 20 张', icon: '卡', tier: 'bronze' },

  { id: 'chapter-1', name: '首章通关', desc: '点亮第一个章节', icon: '首', tier: 'bronze' },
  { id: 'chapter-5', name: '攻城略地', desc: '点亮 5 个章节', icon: '攻', tier: 'silver' },
  { id: 'chapter-all', name: '一统天下', desc: '点亮全部章节', icon: '统', tier: 'gold' },

  { id: 'boss-1', name: '初战告捷', desc: '通关第一个章节 BOSS', icon: '捷', tier: 'silver' },
  { id: 'boss-3', name: '屠龙者', desc: '通关 3 个章节 BOSS', icon: '屠', tier: 'gold' },

  { id: 'level-5', name: '登堂入室', desc: '升到 5 级', icon: '堂', tier: 'bronze' },
  { id: 'level-10', name: '渐入佳境', desc: '升到 10 级', icon: '境', tier: 'gold' },
];

export const ACHIEVEMENT_MAP: Record<string, AchievementMeta> =
  Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

export const LEVEL_TITLES = [
  '初识极限', '数轴新兵', '求导学徒', '积分见习', '级数行者', '多元探索者',
  '曲线猎手', '矩阵行者', '概率赌徒', '极限猎人', '定理克星', '考场主宰',
];

export function levelTitle(level: number) {
  return LEVEL_TITLES[level - 1] || '考场主宰';
}

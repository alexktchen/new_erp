import { readFileSync, writeFileSync } from 'node:fs';

const root = 'D:/project/new_erp/.claude/worktrees/distracted-payne-fb600a';
const files = [
  'apps/member/src/components/MemberTabBar.tsx',
  'apps/member/src/components/SubTabs.tsx',
  'apps/member/src/components/StatusChip.tsx',
  'apps/member/src/components/OrderCard.tsx',
  'apps/member/src/components/SettlementCard.tsx',
  'apps/member/src/app/overview/page.tsx',
  'apps/member/src/app/orders/page.tsx',
  'apps/member/src/app/settlements/page.tsx',
  'apps/member/src/app/me/page.tsx',
  'apps/member/src/app/page.tsx',
  'apps/member/src/app/register/page.tsx',
];

// 大到小 ordered，避免連鎖替換
const bumps = [
  ['text-3xl', 'text-4xl'],
  ['text-2xl', 'text-3xl'],
  ['text-xl',  'text-2xl'],
  ['text-lg',  'text-xl'],
  ['text-base','text-lg'],
  ['text-sm',  'text-base'],
  ['text-xs',  'text-sm'],
];

for (const f of files) {
  const path = `${root}/${f}`;
  let content;
  try { content = readFileSync(path, 'utf8'); }
  catch { console.log(`skip (not found): ${f}`); continue; }

  // 用 unique 占位符避免連鎖
  const tmp = bumps.map(([from, to], i) => [from, `__BUMP_${i}__`, to]);
  for (const [from, ph] of tmp) {
    content = content.split(`${from}"`).join(`${ph}"`);
    content = content.split(`${from} `).join(`${ph} `);
  }
  for (const [, ph, to] of tmp) {
    content = content.split(ph).join(to);
  }

  writeFileSync(path, content, 'utf8');
  console.log(`bumped ${f}`);
}
console.log('done');

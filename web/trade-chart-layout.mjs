// Display-only grouping. Every original fill remains selectable in the list.
export function fillReasons(fill) {
  const groups=new Map();
  for(const t of fill.members??[fill]){const reason=t.reason||'저장된 매매 이유가 없습니다.',row=groups.get(reason)??{reason,count:0};row.count++;groups.set(reason,row);}
  return [...groups.values()];
}
export function displayFills(fills, selectedId) {
  if (fills.length <= 24) return fills.map(t => ({ ...t, members: [t] }));
  const groups = new Map();
  for (const t of fills) {
    const key = t.side + ':' + Math.floor(t.time / 300000);
    const group = groups.get(key) ?? { id: 'group:' + key, side: t.side, time: t.time, quantity: 0, amount: 0, members: [] };
    group.quantity += t.quantity; group.amount += t.price * t.quantity; group.members.push(t);
    groups.set(key, group);
  }
  const rows = [...groups.values()].map(g => g.members.length === 1 ? { ...g.members[0], members: g.members }
    : { ...g, price: g.amount / g.quantity });
  const selected = fills.find(t => t.id === selectedId);
  if (selected && !rows.some(t => t.id === selected.id)) rows.push({ ...selected, members: [selected] });
  return rows;
}

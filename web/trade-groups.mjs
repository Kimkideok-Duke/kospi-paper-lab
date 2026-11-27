export function groupTradeFills(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const key = trade.orderId
      ? JSON.stringify([trade.market, trade.symbol, trade.side, trade.orderId])
      : Symbol();
    const fills = groups.get(key) ?? [];
    fills.push(trade);
    groups.set(key, fills);
  }
  return [...groups.values()].map(fills => {
    if (fills.length === 1) return fills[0];
    const latest = fills.reduce((a,b) => a.time >= b.time ? a : b);
    const sum = field => fills.reduce((total,t) => total + (Number(t[field]) || 0),0);
    const quantity = sum('quantity');
    const costs = fills.every(t=>t.costs) ? Object.fromEntries(
      ['commission','transactionTax','fxSpread','slippage'].map(field => [
        field, fills.reduce((total,t)=>total + (t.costs[field] ?? 0),0)
      ])) : null;
    return {...latest, quantity, amount:sum('amount'), cashAmount:sum('cashAmount'),
      realized:sum('realized'), price:sum('amount')/quantity,
      priceUsd:sum('amountUsd')/quantity,
      fxRate:sum('amountUsd') > 0 ? sum('amount')/sum('amountUsd') : latest.fxRate,
      costs, fills, firstFillTime:Math.min(...fills.map(t=>t.time))};
  });
}

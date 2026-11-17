/** Accounts in the order the person set: the named ids first in that order, the rest after in their own order. */
export function orderAccounts<T extends { id: string }>(list: T[], order: string[] | undefined): T[] {
  if (!order?.length) return list;
  const rank = new Map(order.map((id, i) => [id, i]));
  return list
    .map((a, i) => ({ a, k: rank.get(a.id) ?? order.length + i }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.a);
}

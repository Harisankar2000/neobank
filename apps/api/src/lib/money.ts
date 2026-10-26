/** Money is always an integer number of paise (₹1 = 100 paise). */
export type Paise = number;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function formatInr(paise: Paise): string {
  return inr.format(paise / 100);
}

/** Start of today in India (UTC+5:30), used for daily transfer limits. */
export function startOfIstDay(now = new Date()): Date {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - istOffsetMs);
}

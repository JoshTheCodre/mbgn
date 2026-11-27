// The countries this platform runs in. One codebase serves each on its own domain, with its own
// tables in the same database (Nigeria in the default schema, every other country in its own),
// and one admin who switches between them. Everything that differs by country lives here.

const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi',
  'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

const GHANA_REGIONS = [
  'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern', 'Oti',
  'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North',
];

export const COUNTRIES = {
  ng: {
    id: 'ng',
    name: 'Nigeria',
    demonym: 'Nigerian',
    siteName: 'Most Beautiful Girl Online Nigeria',
    short: 'MBGN',
    codePrefix: 'MBG',
    // Tables live in Postgres's default schema, as they always have.
    schema: 'public',
    sessionCookie: 'mbgn_sid',
    currency: 'NGN',
    symbol: '₦',
    // Prices and payments are whole naira.
    decimals: 0,
    locale: 'en-NG',
    timeZone: 'Africa/Lagos',
    dial: '234',
    // Local numbers: 0 and 10 digits (0803...).
    localDigits: 10,
    samplePhone: '0803 123 4567',
    regions: NIGERIAN_STATES,
    regionLabel: 'State',
    // How votes are paid: a bank transfer to an account Paystack opens for the payment.
    payMethod: 'transfer',
    payLabel: 'by transfer',
    // A bigger bundle is only suggested when it saves at least this much.
    upsellMinSaving: 1000,
    prize: '₦10 million',
    sampleName: 'Stella',
  },
  gh: {
    id: 'gh',
    name: 'Ghana',
    demonym: 'Ghanaian',
    siteName: 'Most Beautiful Girl Ghana',
    short: 'MBGG',
    codePrefix: 'MBGG',
    schema: 'gh',
    sessionCookie: 'mbgg_sid',
    currency: 'GHS',
    symbol: 'GH₵',
    // Votes are cheap in cedis, so charges need pesewas.
    decimals: 2,
    locale: 'en-GH',
    timeZone: 'Africa/Accra',
    dial: '233',
    // Local numbers: 0 and 9 digits (024...).
    localDigits: 9,
    samplePhone: '024 123 4567',
    regions: GHANA_REGIONS,
    regionLabel: 'Region',
    // Mobile Money (MTN MoMo, Telecel Cash, AirtelTigo Money) on Paystack Ghana's checkout.
    payMethod: 'momo',
    payLabel: 'with Mobile Money',
    upsellMinSaving: 5,
    prize: '',
    sampleName: 'Akosua',
  },
};

export const COUNTRY_IDS = Object.keys(COUNTRIES);
export const DEFAULT_COUNTRY = 'ng';

export const countryOf = (id) => COUNTRIES[id] ?? COUNTRIES[DEFAULT_COUNTRY];

// What the browser needs to show prices, regions and wording for its country.
export function siteInfo(id) {
  const c = countryOf(id);
  return {
    country: c.id, name: c.name, demonym: c.demonym, siteName: c.siteName, short: c.short, codePrefix: c.codePrefix,
    currency: c.currency, symbol: c.symbol, decimals: c.decimals, locale: c.locale, timeZone: c.timeZone, dial: c.dial,
    samplePhone: c.samplePhone, regions: c.regions, regionLabel: c.regionLabel, payMethod: c.payMethod, payLabel: c.payLabel,
    upsellMinSaving: c.upsellMinSaving, prize: c.prize, sampleName: c.sampleName,
  };
}

// Rounds a money amount to what the currency can hold: whole naira, or cedis and pesewas.
export const roundMoney = (amount, decimals) => {
  const f = 10 ** decimals;
  return Math.round(amount * f) / f;
};

// A money amount for people to read: "₦1,016" or "GH₵5.10" (symbol), or "NGN 1,016" (code), for
// receipts and messages. Cedis show their pesewas only when there are some.
export function formatMoney(amount, id, { code = false } = {}) {
  const c = countryOf(id);
  const value = roundMoney(Number(amount ?? 0), c.decimals);
  const fraction = Number.isInteger(value) ? 0 : c.decimals;
  const digits = value.toLocaleString(c.locale, { minimumFractionDigits: fraction, maximumFractionDigits: fraction });
  return code ? `${c.currency} ${digits}` : `${c.symbol}${digits}`;
}

// A count for people to read, in the country's style: 1,234.
export const formatCount = (n, id) => Number(n ?? 0).toLocaleString(countryOf(id).locale);

// As WhatsApp wants a number: country code and digits. 0803..., 803... and +234803... are one number.
export function internationalPhone(value, id) {
  const { dial, localDigits } = countryOf(id);
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === dial.length + localDigits && digits.startsWith(dial)) return digits;
  if (digits.length === localDigits + 1 && digits.startsWith('0')) return `${dial}${digits.slice(1)}`;
  if (digits.length === localDigits && !digits.startsWith('0')) return `${dial}${digits}`;
  return null;
}

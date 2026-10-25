// The items every US small business gets, with official links checked by hand (2026-10-25: each URL was
// fetched and answered 200; the SBA's old /business-guide/... pages now redirect to these anchors).

import type { LegalItem, LegalLocation } from "./types";

export const BASE_LINKS = {
  ein: "https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number",
  register: "https://www.sba.gov/counseling/launch-your-business/#register-business",
  licenses: "https://www.sba.gov/counseling/launch-your-business/#licenses-permits",
  /** the IRS list of every state's official government site (find the state tax/revenue department there) */
  stateSites: "https://www.irs.gov/businesses/small-businesses-self-employed/state-government-websites",
  insurance: "https://www.sba.gov/counseling/launch-your-business/#business-insurance",
  bank: "https://www.sba.gov/counseling/launch-your-business/#bank-account",
} as const;

export const BASE_IDS = ["register-business", "ein", "licenses-permits", "sales-tax-permit", "business-insurance", "business-bank-account"] as const;

/** Base items; the location only sharpens the search hints (no agency names are guessed). */
export function baseItems(loc?: LegalLocation): LegalItem[] {
  const state = loc ? stateName(loc.state) : undefined;
  const place = loc ? `${loc.city}, ${loc.state}` : undefined;
  const item = (x: Omit<LegalItem, "status" | "base">): LegalItem => ({ ...x, status: "todo", base: true });
  return [
    item({
      id: "register-business",
      title: "Pick a business structure and register your business",
      why: "Choosing a structure (sole proprietor, LLC and so on) decides your paperwork, taxes and personal liability. Most structures other than a sole proprietorship are registered with your state, and using a name other than your own usually needs a DBA filing.",
      who: "your state's Secretary of State (or business filing office)",
      link: BASE_LINKS.register,
      howToFind: state ? `Search "${state} Secretary of State register a business".` : `Search "<your state> Secretary of State register a business".`,
    }),
    item({
      id: "ein",
      title: "Get an EIN (federal tax ID)",
      why: "An Employer Identification Number identifies your business to the IRS. You need one to hire staff or run an LLC with partners or a corporation, and banks often ask for one. It is free from the IRS.",
      who: "IRS",
      link: BASE_LINKS.ein,
    }),
    item({
      id: "licenses-permits",
      title: "Get your state and local business licenses and permits",
      why: "Most cities or counties require a general business license, and some activities need extra state permits. The rules depend on where you are and what you do.",
      who: "your city or county clerk, and your state's licensing agencies",
      link: BASE_LINKS.licenses,
      howToFind: place ? `Search "${place} business license" and look for the official city or county site.` : `Search "<your city> business license" and look for the official city or county site.`,
    }),
    item({
      id: "sales-tax-permit",
      title: "Get a sales tax permit (if you charge sales tax)",
      why: "If what you sell is taxable where you are, most states require a sales tax permit (often called a seller's permit) before you collect tax. It comes from your state's tax or revenue department, and it is often free.",
      who: "your state's tax or revenue department",
      link: BASE_LINKS.stateSites,
      howToFind: state ? `Search "${state} sales tax permit" on the state's official .gov site.` : `Find your state on the IRS list of state websites, then look for its tax or revenue department.`,
    }),
    item({
      id: "business-insurance",
      title: "Look into business insurance",
      why: "General liability insurance covers you if a customer is hurt or their property is damaged because of your business. Some leases, markets and venues require it, and hiring staff usually means workers' compensation.",
      who: "a licensed insurance agent or broker (your state's insurance department licenses them)",
      link: BASE_LINKS.insurance,
    }),
    item({
      id: "business-bank-account",
      title: "Open a separate business bank account",
      why: "Keeping business money apart from personal money makes your books and taxes much simpler, and it protects you if you form an LLC or corporation. Most banks ask for your EIN or registration papers.",
      who: "a bank or credit union of your choice",
      link: BASE_LINKS.bank,
    }),
  ];
}

// ---- US states ------------------------------------------------------------------------------------

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function stateName(code: string): string {
  return STATES[code] ?? code;
}

/** "tx", "TX", "Texas", " texas " -> "TX"; undefined when it is not a US state. */
export function normalizeState(input: string): string | undefined {
  const s = input.trim().replace(/\.$/, "");
  const up = s.toUpperCase().replace(/\./g, "");
  if (STATES[up]) return up;
  const hit = Object.entries(STATES).find(([, name]) => name.toLowerCase() === s.toLowerCase());
  return hit?.[0];
}

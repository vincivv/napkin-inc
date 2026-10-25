// Getting-legal checklist: shapes shared by the store, the generator and the routes.

export type LegalStatus = "todo" | "done" | "not_needed";
export const LEGAL_STATUSES: readonly LegalStatus[] = ["todo", "done", "not_needed"];

export interface LegalItem {
  /** stable kebab-case id; statuses and notes survive a regenerate when the id does */
  id: string;
  title: string;
  /** one or two plain sentences */
  why: string;
  /** the agency, e.g. "IRS" or "your county health department" */
  who: string;
  /** an official page (https, government host); base links are verified by hand, model links live */
  link?: string;
  /** a search hint when there is no verified link */
  howToFind?: string;
  /** why this applies to THIS business (tailored items) */
  appliesBecause?: string;
  status: LegalStatus;
  note?: string;
  /** true for the items every US small business gets */
  base: boolean;
}

/** City + state the owner typed for the checklist (kept here, never written into the business spec). */
export interface LegalLocation {
  city: string;
  /** two-letter USPS code */
  state: string;
}

export interface LegalChecklist {
  businessId: string;
  version: number;
  updatedAt: string;
  /** set once tailored items were generated; absent while only the base items exist */
  generatedAt?: string;
  /** the location the tailored items were generated for (display text) */
  generatedFor?: string;
  location?: LegalLocation;
  items: LegalItem[];
}

/** What the generator may know about the business: only facts the owner gave (missing ones are absent). */
export interface LegalProfile {
  name?: string;
  oneLiner?: string;
  community?: string;
  /** free-text location from the business spec, only when it is not a guess */
  location?: string;
  hours?: string;
  fulfillment?: string;
  pickupLocation?: string;
  offerings: string[];
}

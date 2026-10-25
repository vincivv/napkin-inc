// Getting-legal checklist: a tailored, honest list of registrations, permits and licenses with official
// links. Napkin does not apply or file anything and does not give legal advice.

export { mountLegal, legalRoutes, type LegalDeps } from "./routes";
export { LegalStore } from "./store";
export { profileFromConfig, profileFromSpec, knowsBusiness } from "./profile";
export { baseItems, BASE_IDS, BASE_LINKS, normalizeState } from "./base";
export { isOfficialHost, linkWorks, officialUrl, type FetchLike } from "./links";
export type { LegalChecklist, LegalItem, LegalLocation, LegalProfile, LegalStatus } from "./types";

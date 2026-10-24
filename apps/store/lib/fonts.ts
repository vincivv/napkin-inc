// Fonts a generated storefront can pick via config.storefront.theme.font.
// next/font needs every font declared statically, so this is a small registry. Only Fraunces is
// preloaded; the others download only when a store actually uses them.
import { DM_Sans, Fraunces, Lora, Nunito, Playfair_Display, Space_Grotesk } from "next/font/google";

const fraunces = Fraunces({ subsets: ["latin"], axes: ["SOFT", "WONK", "opsz"], style: ["normal", "italic"], variable: "--font-fraunces", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap", preload: false });
const lora = Lora({ subsets: ["latin"], variable: "--font-lora", display: "swap", preload: false });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap", preload: false });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const fontVariables = [fraunces, playfair, lora, nunito, spaceGrotesk, dmSans].map((f) => f.variable).join(" ");

// The LLM may only PHRASE the question the code already chose. Guard: every number in the deterministic text
// must survive in the phrasing and no new number may appear; otherwise we fall back to the deterministic text.

import { MODELS, type Llm } from "../llm";

const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join("|");

export function phrasingIsFaithful(base: string, phrased: string): boolean {
  return phrased.length > 0 && phrased.length <= 400 && nums(base) === nums(phrased);
}

export async function phraseQuestion(llm: Llm | undefined, base: string): Promise<{ text: string; phrasedBy: "haiku" | "template" }> {
  if (!llm) return { text: base, phrasedBy: "template" };
  try {
    const out = await llm.text({
      model: MODELS.haiku,
      maxTokens: 200,
      system:
        "You rephrase one question for a small-business owner in a warm, plain, brief way (one or two sentences, no emoji). " +
        "Keep every number, price and name exactly as given. Do not add facts, suggestions or new numbers. Output only the question.",
      user: base,
    });
    return phrasingIsFaithful(base, out) ? { text: out, phrasedBy: "haiku" } : { text: base, phrasedBy: "template" };
  } catch {
    return { text: base, phrasedBy: "template" };
  }
}

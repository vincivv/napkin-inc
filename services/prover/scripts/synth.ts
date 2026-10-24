import { synthesizePostingRule } from "../src/synth";
const vocab = ["line.qty", "line.unitPrice", "doc.discountRate"];
const ex = (q: number, p: string, r: string, out: string) => ({ inputs: { "line.qty": q, "line.unitPrice": p, "doc.discountRate": r }, output: out });
const show = (r: any) => console.log(JSON.stringify({ ...r, expr: undefined, candidates: r.candidates?.map((c: any) => c.rule) }, null, 1));
show(synthesizePostingRule({ examples: [ex(6, "2.50", "0.1", "15.00"), ex(1, "3.00", "0", "3.00"), ex(2, "3.00", "0.2", "6.00")], vocabulary: vocab, target: "revenue" }));
show(synthesizePostingRule({ examples: [ex(6, "2.50", "0.1", "1.50"), ex(1, "3.00", "0.2", "0.60"), ex(3, "1.00", "0.15", "0.45"), ex(1, "0.99", "0.15", "0.15")], vocabulary: vocab, target: "the discount" }));
show(synthesizePostingRule({ examples: [ex(6, "2.50", "0", "15.00"), ex(1, "3.00", "0", "3.00")], vocabulary: vocab, target: "revenue" }));

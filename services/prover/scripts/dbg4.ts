import { getZ3, shutdown } from "../src/z3";
const z = await getZ3();
const I = (n: number | bigint) => z.Int.val(n);
async function run(name: string, maxBp: number, price: number, cost: number, fracCents: boolean) {
  const q = z.Int.const("q"); const b = z.Int.const("b");
  // gross cents = price*q ; discount value = price*q*b/10000 cents ; round2 -> floor((2*price*q*b + 10000)/20000)
  const grossC = q.mul(price);
  const num = grossC.mul(b); // cents * bp  (value in cents = num/10000)
  const discC = fracCents ? num : num.mul(2).add(10000).div(20000);
  const s = new z.Solver(); s.set("timeout", 10000);
  s.add(q.ge(1), q.le(10000), b.ge(0), b.le(maxBp));
  if (fracCents) s.add(num.mod(10000).neq(0));
  else s.add(grossC.sub(discC).mul(100).lt(q.mul(cost * 130))); // net*100 < cost*130*q  (cost cents)
  const t0 = performance.now(); const r = await s.check();
  let ex = ""; if (r === "sat") { const m = s.model(); ex = `q=${m.eval(q)} b=${m.eval(b)}`; }
  console.log(name, r, Math.round(performance.now() - t0) + "ms", ex);
}
await run("floor ok 20%  cookie", 2000, 300, 80, false);
await run("floor ok 20%  box", 2000, 1500, 480, false);
await run("floor bad 75% cookie", 7500, 300, 80, false);
await run("floor at 58.4% box", 5840, 1500, 480, false);
await run("floor at 58.41% box", 5841, 1500, 480, false);
await run("frac cents", 2000, 300, 80, true);
await shutdown();

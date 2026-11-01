import test from "node:test";
import assert from "node:assert/strict";
import { listQuery } from "./internal-query";

const q = (text: string) => listQuery(new URLSearchParams(text));

test("listQuery: accepts only kind and limit with whitelisted values and rebuilds the query itself", () => {
  assert.equal(q(""), "");
  assert.equal(q("kind=batch"), "?kind=batch");
  assert.equal(q("kind=candidates"), "?kind=candidates");
  assert.equal(q("limit=10"), "?limit=10");
  assert.equal(q("kind=batch&limit=10"), "?kind=batch&limit=10");
  // 参数顺序不同，转发出去的顺序固定：网关看到的永远是同一种写法。
  assert.equal(q("limit=10&kind=batch"), "?kind=batch&limit=10");
  for (const limit of ["1", "9", "10", "49", "50"]) assert.equal(q(`limit=${limit}`), `?limit=${limit}`, limit);
});

test("listQuery: refuses everything else (unknown, repeated, out of range, encoded tricks)", () => {
  for (const text of ["kind=other", "kind=", "kind=Batch", "kind=batch%00", "kind=batch&kind=candidates", "limit=0", "limit=51", "limit=100", "limit=-1", "limit=1.5",
    "limit=abc", "limit=", "limit=010", "limit=%31%30%0a", "limit=1&limit=2", "status=running", "owner=00000000-0000-0000-0000-000000000000", "kind=batch&x=1", "x=1",
    "kind[]=batch", "kind=batch%26limit%3D1000"]) {
    assert.equal(q(text), null, text);
  }
});

test("listQuery: percent-encoded valid values are decoded then validated, so only the clean form is forwarded", () => {
  assert.equal(q("kind=%62atch"), "?kind=batch");
  assert.equal(q("limit=%31%30"), "?limit=10");
});

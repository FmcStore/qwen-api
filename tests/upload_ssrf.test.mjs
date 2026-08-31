import assert from "node:assert/strict";
import test from "node:test";

import { fetchFileBytes } from "../upload.js";

// Stand-in resolver: maps a hostname to whatever addresses the test wants,
// so nothing here touches real DNS or the network.
function fakeLookup(table) {
  return async (host) => {
    const answers = table[host];
    if (!answers) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answers;
  };
}

const publicHost = { "files.example.com": [{ address: "93.184.216.34", family: 4 }] };

function okResponse(body = "payload", mime = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": mime }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function redirectTo(location) {
  return { ok: false, status: 302, headers: new Headers({ location }) };
}

test("a public host is fetched normally", async () => {
  const { bytes, mime } = await fetchFileBytes("http://files.example.com/a.png", {
    lookupImpl: fakeLookup(publicHost),
    fetchImpl: async () => okResponse("hello", "image/png; charset=binary"),
  });
  assert.equal(bytes.toString(), "hello");
  assert.equal(mime, "image/png"); // charset stripped
});

test("private and reserved targets are refused before any request goes out", async (t) => {
  const cases = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", "169.254.169.254", 4],
    ["RFC1918 /8", "http://intranet.example.com/x", "10.1.2.3", 4],
    ["RFC1918 /12", "http://intranet.example.com/x", "172.20.0.5", 4],
    ["RFC1918 /16", "http://router.example.com/x", "192.168.1.1", 4],
    ["loopback", "http://localhost.example.com/x", "127.0.0.1", 4],
    ["CGNAT", "http://cgnat.example.com/x", "100.64.0.1", 4],
    ["IPv6 loopback", "http://v6.example.com/x", "::1", 6],
    ["IPv6 unique-local", "http://v6.example.com/x", "fd00::1", 6],
    ["IPv6 link-local", "http://v6.example.com/x", "fe80::1", 6],
    ["IPv4-mapped IPv6", "http://v6.example.com/x", "::ffff:169.254.169.254", 6],
    ["NAT64", "http://v6.example.com/x", "64:ff9b::a9fe:a9fe", 6],
  ];

  for (const [label, url, address, family] of cases) {
    await t.test(label, async () => {
      let called = false;
      const host = new URL(url).hostname;
      await assert.rejects(
        fetchFileBytes(url, {
          lookupImpl: fakeLookup({ [host]: [{ address, family }] }),
          fetchImpl: async () => { called = true; return okResponse(); },
        }),
        /refusing to fetch a private address/,
      );
      assert.equal(called, false, "must not issue the request at all");
    });
  }
});

test("a literal IPv6 URL keeps its brackets out of the resolver", async () => {
  let asked = null;
  await assert.rejects(
    fetchFileBytes("http://[::1]:8787/x", {
      lookupImpl: async (host) => { asked = host; return [{ address: "::1", family: 6 }]; },
      fetchImpl: async () => okResponse(),
    }),
    /refusing to fetch a private address/,
  );
  assert.equal(asked, "::1");
});

test("one public A record does not excuse a private sibling", async () => {
  await assert.rejects(
    fetchFileBytes("http://split.example.com/x", {
      lookupImpl: fakeLookup({
        "split.example.com": [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
      fetchImpl: async () => okResponse(),
    }),
    /refusing to fetch a private address/,
  );
});

test("a redirect into a private range is caught at the hop", async () => {
  const requested = [];
  await assert.rejects(
    fetchFileBytes("http://files.example.com/a.png", {
      lookupImpl: fakeLookup({
        ...publicHost,
        "metadata.example.com": [{ address: "169.254.169.254", family: 4 }],
      }),
      fetchImpl: async (url) => {
        requested.push(url);
        return redirectTo("http://metadata.example.com/latest/meta-data/");
      },
    }),
    /refusing to fetch a private address/,
  );
  assert.deepEqual(requested, ["http://files.example.com/a.png"]);
});

test("a redirect to a public host is followed", async () => {
  const requested = [];
  const { bytes } = await fetchFileBytes("http://files.example.com/a.png", {
    lookupImpl: fakeLookup({
      ...publicHost,
      "cdn.example.com": [{ address: "93.184.216.35", family: 4 }],
    }),
    fetchImpl: async (url) => {
      requested.push(url);
      return url.includes("cdn.") ? okResponse("moved") : redirectTo("http://cdn.example.com/a.png");
    },
  });
  assert.equal(bytes.toString(), "moved");
  assert.equal(requested.length, 2);
});

test("a redirect loop stops at the limit instead of spinning", async () => {
  let hops = 0;
  await assert.rejects(
    fetchFileBytes("http://files.example.com/a.png", {
      lookupImpl: fakeLookup(publicHost),
      fetchImpl: async () => { hops++; return redirectTo("http://files.example.com/a.png"); },
    }),
    /exceeded redirect limit/,
  );
  assert.equal(hops, 4); // initial request + MAX_REDIRECTS
});

test("a redirect to a non-http scheme is refused", async () => {
  await assert.rejects(
    fetchFileBytes("http://files.example.com/a.png", {
      lookupImpl: fakeLookup(publicHost),
      fetchImpl: async () => redirectTo("file:///etc/passwd"),
    }),
    /unsupported redirect scheme/,
  );
});

test("data URLs skip resolution entirely", async () => {
  const { bytes, mime } = await fetchFileBytes(
    "data:image/png;base64," + Buffer.from("inline").toString("base64"),
    { lookupImpl: async () => { throw new Error("must not resolve a data URL"); } },
  );
  assert.equal(bytes.toString(), "inline");
  assert.equal(mime, "image/png");
});

test("an unresolvable host fails instead of being treated as public", async () => {
  await assert.rejects(
    fetchFileBytes("http://nope.example.com/x", {
      lookupImpl: fakeLookup({}),
      fetchImpl: async () => okResponse(),
    }),
    /ENOTFOUND/,
  );
});

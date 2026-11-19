// The Shop catalog switch in Settings: off by default, saved as a boolean, OSA_SHOP_CATALOG wins,
// and the real engine gets it.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigStore } from "../../src/web/config.js";
import { realOptions } from "../../src/web/engine-factory.js";

test("settings: Shop catalog is off by default, saved on request, and the environment wins", async () => {
  const saved = process.env.OSA_SHOP_CATALOG;
  delete process.env.OSA_SHOP_CATALOG;
  try {
    const store = new ConfigStore(await mkdtemp(join(tmpdir(), "osa-cfg-")));
    let pub = await store.publicView();
    assert.equal(pub.shopCatalog, false);
    assert.equal(pub.shopCatalogFromEnv, false);
    assert.equal(realOptions(await store.effective()).shopCatalog, undefined);

    await store.update({ shopCatalog: true });
    assert.equal((await store.read()).shopCatalog, true);
    assert.equal((await store.publicView()).shopCatalog, true);
    assert.equal(realOptions(await store.effective()).shopCatalog, true);

    await store.update({ shopCatalog: "yes" });
    assert.equal((await store.read()).shopCatalog, undefined, "only true switches it on");

    process.env.OSA_SHOP_CATALOG = "1";
    pub = await store.publicView();
    assert.equal(pub.shopCatalog, true);
    assert.equal(pub.shopCatalogFromEnv, true);
    process.env.OSA_SHOP_CATALOG = "0";
    await store.update({ shopCatalog: true });
    assert.equal((await store.publicView()).shopCatalog, false, "OSA_SHOP_CATALOG=0 wins over the setting");
  } finally {
    if (saved === undefined) delete process.env.OSA_SHOP_CATALOG; else process.env.OSA_SHOP_CATALOG = saved;
  }
});

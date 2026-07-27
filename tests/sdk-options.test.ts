// The plugin identifies itself and its version in the SDK User-Agent.
import { describe, expect, it } from "vitest";

import { inkboxClientOptions, pluginUserAgent } from "../src/sdk-options.js";
import pkg from "../package.json" with { type: "json" };

describe("plugin user agent", () => {
  it("names the plugin and its package version", () => {
    expect(pluginUserAgent()).toBe(`inkbox-openclaw/${pkg.version}`);
  });

  it("rides along on the client options", () => {
    const options = inkboxClientOptions("ak_test", undefined);

    expect(options.apiKey).toBe("ak_test");
    expect(options.userAgentPrefix).toBe(pluginUserAgent());
    expect(options.baseUrl).toBeUndefined();
  });

  it("keeps an explicit base url", () => {
    const options = inkboxClientOptions("ak_test", " https://example.test ");

    expect(options.baseUrl).toBe("https://example.test");
    expect(options.userAgentPrefix).toBe(pluginUserAgent());
  });
});

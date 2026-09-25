import { describe, expect, it } from "vitest";
import { ciChange, diffLines, parseFeed, route } from "../src/watchers/watchers";

describe("watchers", () => {
  it("diffs meaningful lines only", () => {
    const d = diffLines("Pricing starts at $29 per month for everyone\nshort", "Pricing starts at $39 per month for everyone\nshort\nNew: enterprise plan with SSO and audit logs");
    expect(d.added).toEqual(["Pricing starts at $39 per month for everyone", "New: enterprise plan with SSO and audit logs"]);
    expect(d.removed).toEqual(["Pricing starts at $29 per month for everyone"]);
  });

  it("parses RSS and Atom", () => {
    const rss = `<rss><channel><item><title><![CDATA[Release 2.0]]></title><link>https://x.dev/2</link><guid>g2</guid></item></channel></rss>`;
    const atom = `<feed><entry><title>Post</title><link href="https://y.dev/p"/><id>tag:y,1</id></entry></feed>`;
    expect(parseFeed(rss)).toEqual([{ id: "g2", title: "Release 2.0", link: "https://x.dev/2" }]);
    expect(parseFeed(atom)).toEqual([{ id: "tag:y,1", title: "Post", link: "https://y.dev/p" }]);
  });

  it("alerts once per failed CI run", () => {
    const run = { id: 7, conclusion: "failure", name: "CI", html_url: "https://gh/run/7", head_branch: "main" };
    const first = ciChange("o/r", run, {});
    expect(first.change?.urgent).toBe(true);
    expect(ciChange("o/r", run, first.state).change).toBeNull();
    expect(ciChange("o/r", { ...run, id: 8, conclusion: "success" }, first.state).change).toBeNull();
  });

  it("routes by importance", () => {
    expect(route({ importance: 0.2, urgent: false, summary: "" })).toBe("ignore");
    expect(route({ importance: 0.5, urgent: false, summary: "" })).toBe("digest");
    expect(route({ importance: 0.85, urgent: false, summary: "" })).toBe("alert");
    expect(route({ importance: 0.1, urgent: true, summary: "" })).toBe("alert");
  });
});

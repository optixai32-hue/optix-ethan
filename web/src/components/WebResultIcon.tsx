"use client";

import { ValidSources } from "@/lib/connectors/types/source";
import { SourceIcon } from "./SourceIcon";
import { useState } from "react";
import { SvgOnyxLogo, SvgGitHub } from "@opal/logos";

/**
 * Favicon providers tried in order; the first URL that loads wins.
 *
 * The original component only consulted the Google favicon service, which
 * makes the icon collapse to a bare globe wherever t3.gstatic.com is
 * unreachable (restricted corporate networks, regional blocks, ...). The
 * extra providers below keep the REAL site favicon visible in those cases:
 *   1. Google Social favicon service (highest quality, official default)
 *   2. DuckDuckGo icon service (independent CDN, different network path)
 *   3. The site's own /favicon.ico (always the site's real icon when served)
 * If every provider fails the standard Web SourceIcon (globe) renders.
 */
const faviconProviders = (hostname: string): string[] => [
  `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${hostname}&size=128`,
  `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
  `https://${hostname}/favicon.ico`,
];

export function WebResultIcon({
  url,
  size = 18,
}: {
  url: string;
  size?: number;
}) {
  // Track which provider URLs have failed for THIS component instance; the
  // first unfailed candidate renders. Keyed per-URL so a changing url prop
  // naturally re-evaluates from the top of the chain.
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());

  let hostname = "";
  let parseFailed = false;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    parseFailed = true;
  }
  if (!hostname) parseFailed = true;

  if (parseFailed) {
    // Unparseable/missing link: fall back to the plain web source icon —
    // never render the Onyx logo for a site we could not identify.
    return <SourceIcon sourceType={ValidSources.Web} iconSize={size} />;
  }

  if (hostname.includes("onyx.app")) {
    return <SvgOnyxLogo size={size} className="dark:text-white text-black" />;
  }
  if (hostname === "github.com" || hostname.endsWith(".github.com")) {
    return <SvgGitHub size={size} />;
  }

  const candidates = faviconProviders(hostname);
  const active = candidates.find((candidate) => !failedUrls.has(candidate));
  if (!active) {
    // Every provider failed (e.g. fully offline browser) — globe fallback.
    return <SourceIcon sourceType={ValidSources.Web} iconSize={size} />;
  }

  return (
    <img
      className="my-0 rounded-full py-0"
      src={active}
      alt="favicon"
      height={size}
      onError={() =>
        setFailedUrls((prev) => {
          const next = new Set(prev);
          next.add(active);
          return next;
        })
      }
      width={size}
      style={{
        height: `${size}px`,
        width: `${size}px`,
        background: "transparent",
      }}
    />
  );
}

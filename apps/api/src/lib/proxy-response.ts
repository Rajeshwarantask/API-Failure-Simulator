import type { Response } from "express";

export function sendUpstreamTimeout(res: Response): void {
  res.status(504);
  res.setHeader("x-simulator-rule", "none");
  res.json({ error: "upstream_timeout" });
}

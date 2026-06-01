import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMultipartAlternativeBody,
  createMultipartBoundary,
} from "./smtp.ts";

Deno.test("multipart Content-Type belongs in headers not body", () => {
  const boundary = createMultipartBoundary();
  const body = buildMultipartAlternativeBody("hi", "<p>hi</p>", boundary);
  assertEquals(body.startsWith(`--${boundary}`), true);
  assertEquals(body.includes("Content-Type: multipart/alternative"), false);

  const fakeHeaders = [
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const raw = `${fakeHeaders}\r\n\r\n${body}`;
  assertMatch(raw, /Content-Type: multipart\/alternative; boundary="/);
  const headerBodySplit = raw.indexOf("\r\n\r\n");
  const headerSection = raw.slice(0, headerBodySplit);
  const bodySection = raw.slice(headerBodySplit + 4);
  assertEquals(headerSection.includes("multipart/alternative"), true);
  assertEquals(bodySection.startsWith(`--${boundary}`), true);
});

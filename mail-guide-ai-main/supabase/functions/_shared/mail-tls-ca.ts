/**
 * 自建 edge-runtime User Worker：自定义 `Deno.env` 可能不可用；
 * 默认从 `../certs/mail-ca.pem`（相对本模块，即 `functions/certs/mail-ca.pem`）读取。
 */
const SELFHOST_DEFAULT_MAIL_CA_ABS = "/home/deno/functions/certs/mail-ca.pem";
const SELFHOST_DEFAULT_PUBLIC_CA_ABS = "/home/deno/functions/certs/public-ca.pem";
const BUNDLED_163_MAIL_CA_PEM = `-----BEGIN CERTIFICATE-----
MIID3DCCAsSgAwIBAgIIQ+Re43aaeBgwDQYJKoZIhvcNAQELBQAwOzEQMA4GA1UE
ChMHVGVjU2dpbjEQMA4GA1UECxMHVGVjU2lnbjEVMBMGA1UEAxMMVGVjU2lnbi1S
b290MB4XDTI2MDUwODA3MDkyNloXDTI3MDUwODA3MDkyNlowODEQMA4GA1UEChMH
VGVjU2lnbjEQMA4GA1UECxMHVGVjU2lnbjESMBAGA1UEAwwJKi4xNjMuY29tMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwvVUzBGQPfxTwXyypNbHkhdb
RP8L9j8xh0VfoQwWSllrwu3QRXx3f3+YTDl4kpCFftCHhoisCQpWJAoS89mQcAA9
2dsk3uAFBKkMnNZVekGD781TSvC4KBR0tU+5WCETSvlUxhoZtosrQ3bpZnCGcnWV
xcxpoUSd0hPs9xhPFMpNWMIxZlg/98PDGo5PW1i3dPVhCbPHWK+EdVnmj3tmoPPB
6F45LFzyfoTRKXFYF9SdWsmn7/peCbclGWqZvi6/+yt3pEjZQRqDF8SpsuIJJ/NA
2nxRAOrLKCwuPP2izQKK2ZONIOd6YR4QeIeWW7oh1JRNo5HqAIHmMToWKJu5OQID
AQABo4HmMIHjMB0GA1UdDgQWBBQyNgSS1OIUFOk1/K541BSnF2fyUTBqBgNVHSME
YzBhgBQft5ZPV86Ui4fiWv7dHe2XDOM9yaE/pD0wOzEQMA4GA1UEChMHVGVjU2dp
bjEQMA4GA1UECxMHVGVjU2lnbjEVMBMGA1UEAxMMVGVjU2lnbi1Sb290gggt3pw2
uXf92TAMBgNVHRMBAf8EAjAAMAsGA1UdDwQEAwIFoDATBgNVHSUEDDAKBggrBgEF
BQcDATAmBgNVHREEHzAdghBUZWNTaWduLVRlbXBsYXRlggkqLjE2My5jb20wDQYJ
KoZIhvcNAQELBQADggEBAC4FNLzuj1wKGRhlIZvOFph6NK1NRMJRj8lsL+xU9Xa4
LkctnpgVjTprnmo9Q044vGeDK2Ek7g4pyTgeG+/vHf0JLoGSLGwpkDQg4lPBST/D
rgooC3FoIvSKULOr7PrTlyKuQ/Oe+4g7I3ncB6jbE/ONAnAvu1A2KyTg/UtbC+G7
h2xbrbi31Ny7Pg9fWw0BzFu2Ts8mF66hUADQPU0VSOMdcVjwDhZJwy2I7P0q9qBl
GxPRRhUy/0/jdSqLffXL0veDrmcZOu8zIOqp8og4eqzN+tp9JXz063nmawWW5lFC
byiHKIm6KR3Wi01B3fTQR0INOArMPS7/NjesWh4dgII=
-----END CERTIFICATE-----

-----BEGIN CERTIFICATE-----
MIIDajCCAlKgAwIBAgIILd6cNrl3/dkwDQYJKoZIhvcNAQELBQAwOzEQMA4GA1UE
ChMHVGVjU2dpbjEQMA4GA1UECxMHVGVjU2lnbjEVMBMGA1UEAxMMVGVjU2lnbi1S
b290MB4XDTIyMDgwOTA5MjgwMFoXDTMyMDgwOTA5MjgwMFowOzEQMA4GA1UEChMH
VGVjU2dpbjEQMA4GA1UECxMHVGVjU2lnbjEVMBMGA1UEAxMMVGVjU2lnbi1Sb290
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2wJ3zzw6sg8b7hprsmsI
3GfLHKSTJfrxgMQISJCR5VrYmqmDpj+Qchl3mvf/s6yawkyldzxc80UflHwE7C6q
ddCBWeYu2q9sS2E/Ss4jq5n642W+FSYcnKXEO22KDY7+KDPTR30Ixmra+p3DiUfv
Xji2yf/h8f7zSM4BA3N5SKlSczAqb0ygXUZ0oSg60Qi6iVqJyk1odMYNvH9Sg5iT
r02OKJWPzUytgTTWkhLKyErfhzxiiFq3XImRtV42krs/P6Opzi/YJWV72fMq352q
1weMPssYHc77awsg8TbUjN72EKc/Rg8KxQGQCIMwgo3TRIBEfCcOh3gDP14LpJiU
UQIDAQABo3IwcDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBQft5ZPV86Ui4fi
Wv7dHe2XDOM9yTALBgNVHQ8EBAMCAQYwEQYJYIZIAYb4QgEBBAQDAgAHMB4GCWCG
SAGG+EIBDQQRFg94Y2EgY2VydGlmaWNhdGUwDQYJKoZIhvcNAQELBQADggEBAK4u
knj2ugDZ6bSlV8Hzf19BCF2EkzlWOAu0WnmlIO43C4C/jaKoNdGRRX+0Lzbu5GoF
EX5rQrx989MYJ7CK0DvLO56iuKxLxRYhPeuTTCL+NXDrIbsOfCuGzISjpew8TsvS
2zS50CoeumTkDyTf+FsTNmeAVCuQIAjTG5zsEEHUYAwKsK/tFvEFb/2VSGg758cY
A1s6ziHEP7LR1pzNQ3iOH9KgFGXPQy+qVPl0Dho6aalfnxdRrupq9m3KZ+ejaeSI
giVx5VBnx6iOgoswa4+1nNu0wWnXhK7q8bMDoefDfFlcuecVumRnbD1F1pV6CvNH
sAowApX3hRFMlnrwaM8=
-----END CERTIFICATE-----`;

let cachedMailTlsCaCerts: string[] | undefined | null;
let cachedPublicTlsCaCerts: string[] | undefined | null;

/** 自建 edge-runtime 内 Deno 默认不信任系统 CA，需显式加载容器/宿主机 CA 包 */
const PUBLIC_CA_DEFAULT_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/** 将 PEM 文件/字符串拆成多段证书，供 `connectTls({ caCerts })` 使用 */
function splitPemCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

function appendPemMaterial(certs: string[], raw: string, logPrefix: string, source: string) {
  const blocks = splitPemCertificates(raw);
  if (blocks.length === 0) {
    console.error(`${logPrefix}no PEM blocks parsed from ${source}`);
    return;
  }
  certs.push(...blocks);
  console.log(`${logPrefix}parsed ${blocks.length} certificate(s) from ${source}`);
}

export async function getMailTlsCaCerts(logPrefix: string): Promise<string[] | undefined> {
  if (cachedMailTlsCaCerts !== null && cachedMailTlsCaCerts !== undefined) {
    return cachedMailTlsCaCerts;
  }

  const certs: string[] = [];
  const inlinePem = Deno.env.get("MAIL_TLS_CA_CERT_PEM")?.trim();
  if (inlinePem) {
    appendPemMaterial(certs, inlinePem.replace(/\\n/g, "\n"), logPrefix, "MAIL_TLS_CA_CERT_PEM");
  }

  const rawPaths = Deno.env.get("MAIL_TLS_CA_CERT_PATH") || Deno.env.get("DENO_CERT") || "";
  const paths = rawPaths.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  for (const path of paths) {
    try {
      const raw = await Deno.readTextFile(path);
      appendPemMaterial(certs, raw, logPrefix, path);
    } catch (e) {
      console.warn(`${logPrefix}optional CA cert unreadable path=${path}:`, e);
    }
  }

  if (certs.length === 0) {
    const defaultCandidates: Array<string | URL> = [
      new URL("../certs/mail-ca.pem", import.meta.url),
      SELFHOST_DEFAULT_MAIL_CA_ABS,
    ];
    for (const cand of defaultCandidates) {
      try {
        const raw = await Deno.readTextFile(cand);
        appendPemMaterial(certs, raw, logPrefix, String(cand));
        if (certs.length > 0) break;
      } catch {
        // 将回退到内置 163 CA
      }
    }
  }

  if (certs.length === 0) {
    appendPemMaterial(certs, BUNDLED_163_MAIL_CA_PEM, logPrefix, "bundled 163 mail CA");
  }

  cachedMailTlsCaCerts = certs.length > 0 ? certs : null;
  return cachedMailTlsCaCerts ?? undefined;
}

/** Gmail/Outlook 等公网邮箱：加载 Mozilla/系统 CA 包（Deno 不会自动读 /etc/ssl） */
export async function getPublicTlsCaCerts(logPrefix: string): Promise<string[] | undefined> {
  if (cachedPublicTlsCaCerts !== null) {
    return cachedPublicTlsCaCerts ?? undefined;
  }

  const certs: string[] = [];
  const envPaths = (Deno.env.get("MAIL_PUBLIC_CA_CERT_PATH") || "")
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const fileCandidates: Array<string | URL> = [
    ...envPaths,
    new URL("../certs/public-ca.pem", import.meta.url),
    SELFHOST_DEFAULT_PUBLIC_CA_ABS,
    ...PUBLIC_CA_DEFAULT_PATHS,
  ];
  for (const cand of fileCandidates) {
    try {
      const raw = await Deno.readTextFile(cand);
      appendPemMaterial(certs, raw, logPrefix, String(cand));
      if (certs.length > 0) break;
    } catch (e) {
      console.warn(`${logPrefix}optional public CA unreadable path=${String(cand)}:`, e);
    }
  }

  cachedPublicTlsCaCerts = certs.length > 0 ? certs : null;
  if (!cachedPublicTlsCaCerts) {
    console.warn(
      `${logPrefix}no public CA bundle loaded; Gmail/Outlook TLS may fail with UnknownIssuer`,
    );
  }
  return cachedPublicTlsCaCerts ?? undefined;
}

export async function getTlsCaCertsForHost(
  hostname: string,
  logPrefix: string,
): Promise<string[] | undefined> {
  return hostNeedsCustomMailCa(hostname)
    ? await getMailTlsCaCerts(logPrefix)
    : await getPublicTlsCaCerts(logPrefix);
}

/** 网易/腾讯企业邮等需附加 CA；Gmail/Outlook 等使用公网 CA 包 */
export function hostNeedsCustomMailCa(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  return (
    h.includes("163.com") ||
    h.includes("126.com") ||
    h.includes("yeah.net") ||
    h.includes("188.com") ||
    h.includes("tom.com") ||
    h.includes("qiye.163") ||
    h.includes("exmail.qq") ||
    h.endsWith(".qq.com") && h.includes("exmail")
  );
}

export function isTransientTlsConnectError(err: unknown): boolean {
  const text = tlsErrorText(err);
  return /unexpected end of file|UnexpectedEof|connection (closed|reset)|ECONNRESET|broken pipe|tls handshake/i
    .test(text);
}

function tlsErrorText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name} ${err.message} ${String(err)}`;
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const message = typeof o.message === "string" ? o.message : "";
    if (name || message) return `${name} ${message}`.trim();
  }
  return String(err ?? "");
}

export function isUnknownIssuerTlsError(err: unknown): boolean {
  return /UnknownIssuer|invalid peer certificate/i.test(tlsErrorText(err));
}

function mailTlsPreferCustomCa(): boolean {
  return (
    Deno.env.get("MAIL_TLS_FORCE_CUSTOM_CA") === "true" ||
    Boolean(Deno.env.get("MAIL_TLS_CA_CERT_PATH")?.trim())
  );
}

async function denoConnectTls(
  hostname: string,
  port: number,
  signal: AbortSignal | undefined,
  caCerts: string[] | undefined,
): Promise<Deno.TlsConn> {
  return await Deno.connectTls({
    hostname,
    port,
    ...(signal ? { signal } : {}),
    ...(caCerts?.length ? { caCerts } : {}),
  });
}

/**
 * IMAP/SMTP over TLS。
 * - 163/企业邮：TecSign 等自定义 CA
 * - Gmail 等：先公网 CA；若 UnknownIssuer（常见于公司 SSL 审计/MITM）则回退自定义 CA
 */
export async function connectMailImapTls(
  hostname: string,
  port: number,
  signal?: AbortSignal,
  logPrefix = "",
): Promise<Deno.TlsConn> {
  const useCustom = hostNeedsCustomMailCa(hostname) || mailTlsPreferCustomCa();

  if (useCustom) {
    const caCerts = await getMailTlsCaCerts(logPrefix);
    console.log(`${logPrefix}IMAP TLS custom CA for host:`, hostname);
    try {
      return await denoConnectTls(hostname, port, signal, caCerts);
    } catch (firstErr) {
      if (!isTransientTlsConnectError(firstErr)) throw firstErr;
      const publicCa = await getPublicTlsCaCerts(logPrefix);
      console.warn(`${logPrefix}custom CA connect failed for ${hostname}, retry public CA:`, firstErr);
      return await denoConnectTls(hostname, port, signal, publicCa);
    }
  }

  const publicCa = await getPublicTlsCaCerts(logPrefix);
  if (publicCa?.length) {
    console.log(`${logPrefix}IMAP TLS public CA bundle (${publicCa.length} certs) for host:`, hostname);
  }
  try {
    return await denoConnectTls(hostname, port, signal, publicCa);
  } catch (firstErr) {
    const customCa = await getMailTlsCaCerts(logPrefix);
    console.warn(
      `${logPrefix}public CA connect failed for ${hostname}, retry custom CA (${tlsErrorText(firstErr)})`,
    );
    try {
      return await denoConnectTls(hostname, port, signal, customCa);
    } catch (secondErr) {
      throw isUnknownIssuerTlsError(firstErr) ? firstErr : secondErr;
    }
  }
}

/** SMTP STARTTLS：与 connectMailImapTls 相同的 CA 选择/回退策略 */
export async function startMailSmtpTls(
  conn: Deno.TcpConn,
  hostname: string,
  logPrefix = "",
): Promise<Deno.TlsConn> {
  const useCustom = hostNeedsCustomMailCa(hostname) || mailTlsPreferCustomCa();
  const tryStart = (caCerts: string[] | undefined) =>
    Deno.startTls(conn, { hostname, ...(caCerts?.length ? { caCerts } : {}) });

  if (useCustom) {
    return await tryStart(await getMailTlsCaCerts(logPrefix));
  }
  try {
    return await tryStart(await getPublicTlsCaCerts(logPrefix));
  } catch (firstErr) {
    console.warn(`${logPrefix}SMTP STARTTLS public CA failed, retry custom CA:`, tlsErrorText(firstErr));
    return await tryStart(await getMailTlsCaCerts(logPrefix));
  }
}

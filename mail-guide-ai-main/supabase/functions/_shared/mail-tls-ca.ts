/**
 * 自建 edge-runtime User Worker：自定义 `Deno.env` 可能不可用；
 * 默认从 `../certs/mail-ca.pem`（相对本模块，即 `functions/certs/mail-ca.pem`）读取。
 */
const SELFHOST_DEFAULT_MAIL_CA_ABS = "/home/deno/functions/certs/mail-ca.pem";
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

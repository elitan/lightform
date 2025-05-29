import { SSHClient } from "../ssh";

export interface DomainStatus {
  domain: string;
  accessible: boolean;
  hasSSL: boolean;
  sslInfo?: {
    issuer: string;
    validFrom: Date;
    validTo: Date;
    daysUntilExpiry: number;
    status: "valid" | "expired" | "expiring_soon" | "invalid";
  };
  error?: string;
}

/**
 * Checks if a domain is accessible via HTTP/HTTPS
 */
async function checkDomainAccessibility(
  domain: string,
  sshClient: SSHClient,
  verbose: boolean = false
): Promise<{ accessible: boolean; error?: string }> {
  try {
    // First try HTTP
    const httpResult = await sshClient.exec(
      `timeout 10 curl -s -o /dev/null -w "%{http_code}" http://${domain}`
    );

    if (httpResult && parseInt(httpResult) < 400) {
      return { accessible: true };
    }

    // Then try HTTPS
    const httpsResult = await sshClient.exec(
      `timeout 10 curl -s -o /dev/null -w "%{http_code}" https://${domain}`
    );

    if (httpsResult && parseInt(httpsResult) < 400) {
      return { accessible: true };
    }

    return {
      accessible: false,
      error: `HTTP returned ${httpResult || "error"}, HTTPS returned ${
        httpsResult || "error"
      }`,
    };
  } catch (error) {
    return {
      accessible: false,
      error: `Failed to check accessibility: ${error}`,
    };
  }
}

/**
 * Gets SSL certificate information for a domain
 */
async function getSSLCertificateInfo(
  domain: string,
  sshClient: SSHClient,
  verbose: boolean = false
): Promise<{
  hasSSL: boolean;
  sslInfo?: DomainStatus["sslInfo"];
  error?: string;
}> {
  try {
    // Use openssl to get certificate information
    const certCommand = `timeout 10 openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -dates -issuer 2>/dev/null`;

    const result = await sshClient.exec(certCommand);

    if (!result || result.trim() === "") {
      return {
        hasSSL: false,
        error: `No SSL certificate found or connection failed`,
      };
    }

    // Parse the certificate output
    const lines = result.split("\n");
    let issuer = "";
    let validFrom: Date | null = null;
    let validTo: Date | null = null;

    for (const line of lines) {
      if (line.startsWith("issuer=")) {
        issuer = line.replace("issuer=", "").trim();
      } else if (line.startsWith("notBefore=")) {
        const dateStr = line.replace("notBefore=", "").trim();
        validFrom = new Date(dateStr);
      } else if (line.startsWith("notAfter=")) {
        const dateStr = line.replace("notAfter=", "").trim();
        validTo = new Date(dateStr);
      }
    }

    if (!validFrom || !validTo) {
      return {
        hasSSL: false,
        error: "Could not parse certificate dates",
      };
    }

    const now = new Date();
    const daysUntilExpiry = Math.ceil(
      (validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    let status: "valid" | "expired" | "expiring_soon" | "invalid";
    if (validTo < now) {
      status = "expired";
    } else if (daysUntilExpiry <= 30) {
      status = "expiring_soon";
    } else if (validFrom <= now && validTo > now) {
      status = "valid";
    } else {
      status = "invalid";
    }

    return {
      hasSSL: true,
      sslInfo: {
        issuer,
        validFrom,
        validTo,
        daysUntilExpiry,
        status,
      },
    };
  } catch (error) {
    return {
      hasSSL: false,
      error: `Failed to check SSL certificate: ${error}`,
    };
  }
}

/**
 * Checks domain and SSL status for a given domain
 */
export async function checkDomainStatus(
  domain: string,
  sshClient: SSHClient,
  verbose: boolean = false
): Promise<DomainStatus> {
  const accessibilityResult = await checkDomainAccessibility(
    domain,
    sshClient,
    verbose
  );
  const sslResult = await getSSLCertificateInfo(domain, sshClient, verbose);

  return {
    domain,
    accessible: accessibilityResult.accessible,
    hasSSL: sslResult.hasSSL,
    sslInfo: sslResult.sslInfo,
    error: accessibilityResult.error || sslResult.error,
  };
}

/**
 * Formats domain status for display
 */
export function formatDomainStatus(domainStatus: DomainStatus): string[] {
  const lines: string[] = [];

  const accessIcon = domainStatus.accessible ? "[✓]" : "[✗]";
  const sslIcon = domainStatus.hasSSL ? "[🔒]" : "[🔓]";

  lines.push(
    `     ├─ Domain: ${domainStatus.domain} ${accessIcon} ${
      domainStatus.accessible ? "accessible" : "not accessible"
    }`
  );

  if (domainStatus.hasSSL && domainStatus.sslInfo) {
    const { sslInfo } = domainStatus;
    let statusText = "";
    let statusIcon = "";

    switch (sslInfo.status) {
      case "valid":
        statusText = `valid (${sslInfo.daysUntilExpiry} days left)`;
        statusIcon = "[✓]";
        break;
      case "expiring_soon":
        statusText = `expiring soon (${sslInfo.daysUntilExpiry} days left)`;
        statusIcon = "[⚠]";
        break;
      case "expired":
        statusText = "expired";
        statusIcon = "[✗]";
        break;
      case "invalid":
        statusText = "invalid";
        statusIcon = "[✗]";
        break;
    }

    lines.push(`     ├─ SSL: ${statusIcon} ${statusText}`);
    lines.push(`     ├─ Issuer: ${sslInfo.issuer}`);
    lines.push(
      `     ├─ Valid: ${sslInfo.validFrom.toLocaleDateString()} - ${sslInfo.validTo.toLocaleDateString()}`
    );
  } else {
    lines.push(`     ├─ SSL: ${sslIcon} No SSL certificate`);
  }

  if (domainStatus.error) {
    lines.push(`     ├─ Error: ${domainStatus.error}`);
  }

  return lines;
}

export function hostMatchesCookieDomain(host, cookieDomain) {
    const normalizedHost = host.toLowerCase();
    const normalizedDomain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const domainLower = normalizedDomain.toLowerCase();
    return normalizedHost === domainLower || normalizedHost.endsWith(`.${domainLower}`);
}
//# sourceMappingURL=hostMatch.js.map
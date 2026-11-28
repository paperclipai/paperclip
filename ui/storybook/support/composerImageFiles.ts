export async function composerImageFiles() {
  const sources = [
    ["/project-skills-evidence/sources-desktop.jpg", "desktop-reference.jpg"],
    ["/project-skills-evidence/repair-conflict-mobile.jpg", "mobile-reference.jpg"],
  ] as const;
  return Promise.all(sources.map(async ([path, name]) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Image fixture unavailable: ${path}`);
    return new File([await response.blob()], name, { type: "image/jpeg" });
  }));
}

import fs from 'node:fs/promises';
export async function readTextFileIfExists(filePath) {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile())
            return null;
        return await fs.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=fs.js.map
import { t, useTranslation, Trans } from "@/i18n";
import { useEffect, useState } from 'react';
import type { CompanySkillFileDetail } from '@paperclipai/shared';
import { Button } from './ui/button';
export function SkillBinaryFile({ file }: { file: CompanySkillFileDetail }) {
  useTranslation("task-components");
  const [url, setUrl] = useState('');
  useEffect(() => {
    const bytes = Uint8Array.from(atob(file.content), char => char.charCodeAt(0));
    const href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    setUrl(href); return () => URL.revokeObjectURL(href);
  }, [file.content]);
  return <div className="flex flex-col items-start gap-3 py-6">
    <p className="text-sm text-muted-foreground">{t("task-components:thisAssetIsStoredInItsOriginal_067464c2")}</p>
    <Button asChild variant="outline" className="max-w-full"><a href={url} download={file.path.split('/').at(-1)} title={t("task-components:download_8fe1a08e", { value1: file.path.split('/').at(-1) })}><span className="truncate"><Trans ns="task-components" i18nKey="sentence_a257b041839a" components={{ part1: <>{file.path.split('/').at(-1)}</> }} /></span></a></Button>
  </div>;
}

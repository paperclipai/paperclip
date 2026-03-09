export function KnowledgeDetailCardHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      data-slot="card-header"
      className="@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 border-b px-6 pt-6 pb-6"
    >
      <div data-slot="card-title" className="text-sm leading-none font-semibold">
        {title}
      </div>
      <div data-slot="card-description" className="text-muted-foreground text-sm">
        {description}
      </div>
    </div>
  );
}

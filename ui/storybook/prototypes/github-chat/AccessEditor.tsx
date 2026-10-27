import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface AllowedPerson {
  id: string;
  login: string;
  name?: string;
  kind: "member" | "guest";
  sponsor: string;
  automatic: boolean;
}
export interface AccessPolicy {
  members: "all" | "selected";
  people: AllowedPerson[];
}
export function initialAccess(guest = false): AccessPolicy {
  return {
    members: "all",
    people: [
      {
        id: "member-dotta",
        login: "dotta",
        name: "Dotta",
        kind: "member",
        sponsor: "Dotta",
        automatic: true,
      },
      ...(guest
        ? [
            {
              id: "github-1042",
              login: "external-contributor",
              kind: "guest" as const,
              sponsor: "Dotta",
              automatic: false,
            },
          ]
        : []),
    ],
  };
}
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
export function AccessEditor({
  value,
  onChange,
}: {
  value: AccessPolicy;
  onChange: (value: AccessPolicy) => void;
}) {
  const [adding, setAdding] = useState<"member" | "guest" | null>(null);
  const [handle, setHandle] = useState("external-contributor");
  const [found, setFound] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [sponsor, setSponsor] = useState("Dotta");
  const [member, setMember] = useState("Alex");
  const [message, setMessage] = useState("");
  const alreadyAdded = value.people.some(
    (person) => person.id === "github-1042",
  );
  const updatePerson = (id: string, patch: Partial<AllowedPerson>) =>
    onChange({
      ...value,
      people: value.people.map((person) =>
        person.id === id ? { ...person, ...patch } : person,
      ),
    });
  const add = () => {
    const person: AllowedPerson =
      adding === "guest"
        ? {
            id: "github-1042",
            login: "external-contributor",
            kind: "guest",
            sponsor,
            automatic: false,
          }
        : {
            id: "member-alex",
            login: "alex",
            name: "Alex Chen",
            kind: "member",
            sponsor: "Alex",
            automatic: false,
          };
    onChange({
      ...value,
      members: adding === "member" ? "selected" : value.members,
      people: [...value.people, person],
    });
    setAdding(null);
    setMessage(
      `@${person.login} can request work by mentioning the bot.`,
    );
  };
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">Who can start work</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Mentions create or continue a task on this bot’s assigned agent.
          Repository and publication permissions still apply.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="allowed-members">Paperclip members</Label>
        <select
          id="allowed-members"
          className={selectClass}
          value={value.members}
          onChange={(event) =>
            onChange({
              ...value,
              members: event.target.value as AccessPolicy["members"],
            })
          }
        >
          <option value="all">All linked company members</option>
          <option value="selected">Selected members only</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {value.members === "all"
            ? "Members with a linked personal GitHub account can mention the bot. Their PRs follow the connection’s automatic review rules; individual settings below take precedence."
            : "Only the members listed below can mention this bot. Each person must link their own personal GitHub connection."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setAdding("member");
            setMessage("");
          }}
        >
          Add Paperclip member
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setAdding("guest");
            setFound(false);
            setLookupError("");
            setMessage("");
          }}
        >
          Allow GitHub user
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <div className="divide-y divide-border rounded-lg border border-border">
        {value.people.map((person) => (
          <article
            key={person.id}
            aria-label={`Access for @${person.login}`}
            className="space-y-3 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {person.name ? `${person.name} · ` : ""}@{person.login}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {person.kind === "member"
                    ? "Paperclip member · uses their current permissions"
                    : "Restricted guest · no Paperclip membership or personal credentials"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove access for @${person.login}`}
                onClick={() => {
                  onChange({
                    ...value,
                    people: value.people.filter(
                      (item) => item.id !== person.id,
                    ),
                    members:
                      person.kind === "member" ? "selected" : value.members,
                  });
                  setMessage(
                    `Access removed for @${person.login}.${person.kind === "member" ? " Member access is now limited to the selected list." : ""}`,
                  );
                }}
              >
                Remove access
              </Button>
            </div>
            {person.kind === "guest" ? (
              <div className="space-y-2">
                <Label htmlFor={`sponsor-${person.id}`}>
                  Responsible sponsor for @{person.login}
                </Label>
                <select
                  id={`sponsor-${person.id}`}
                  className={selectClass}
                  value={person.sponsor}
                  onChange={(event) =>
                    updatePerson(person.id, { sponsor: event.target.value })
                  }
                >
                  <option>Dotta</option>
                  <option>Alex</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Restricted permission profile. Requests stop if this sponsor
                  loses authority.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Responsible user for mentions: {person.name}
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">
                  Automatically review PRs by @{person.login}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Also requires enabled events and matching review filters.
                </p>
              </div>
              <ToggleSwitch
                aria-label={`Automatically review PRs by @${person.login}`}
                checked={person.automatic}
                onCheckedChange={(automatic) =>
                  updatePerson(person.id, { automatic })
                }
              />
            </div>
          </article>
        ))}
        {!value.people.length && (
          <p className="p-4 text-sm text-muted-foreground">
            No people added to the selected list.
          </p>
        )}
      </div>
      <Dialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {adding === "member"
                ? "Add Paperclip member"
                : "Allow GitHub user"}
            </DialogTitle>
            <DialogDescription>
              {adding === "member"
                ? "Choose an existing company member. They use their own Paperclip permissions and linked GitHub account."
                : "Allow a specific GitHub account to mention this bot, without inviting them to Paperclip."}
            </DialogDescription>
          </DialogHeader>
          {adding === "member" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="access-member">Member</Label>
                <select
                  id="access-member"
                  className={selectClass}
                  value={member}
                  onChange={(event) => setMember(event.target.value)}
                >
                  <option value="Alex">
                    Alex Chen · @alex · GitHub linked
                  </option>
                  <option value="Sam">Sam · GitHub not linked</option>
                </select>
              </div>
              <p className="text-sm text-muted-foreground">
                {member === "Sam"
                  ? "Sam must link a personal GitHub connection in Access before being added."
                  : "Adding a member switches access to Selected members only. Existing entries stay on the list."}
              </p>
              <Button
                disabled={
                  member !== "Alex" ||
                  value.people.some((person) => person.id === "member-alex")
                }
                onClick={add}
              >
                Add member
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="github-access-username">GitHub username</Label>
                <Input
                  id="github-access-username"
                  value={handle}
                  onChange={(event) => {
                    setHandle(event.target.value);
                    setFound(false);
                    setLookupError("");
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Preview lookup supports @external-contributor. No request is
                  sent to GitHub.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  const match =
                    handle.trim().replace(/^@/, "").toLowerCase() ===
                    "external-contributor";
                  setFound(match);
                  setLookupError(
                    match
                      ? ""
                      : "No matching preview account. Use external-contributor to try this flow.",
                  );
                }}
              >
                Look up account
              </Button>
              {lookupError && (
                <p role="alert" className="text-sm text-destructive">
                  {lookupError}
                </p>
              )}
              {found && (
                <>
                  <div className="rounded-md border border-border p-3 text-sm">
                    <strong>@external-contributor</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Verified GitHub account · preview
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-guest-sponsor">
                      Responsible sponsor
                    </Label>
                    <select
                      id="new-guest-sponsor"
                      className={selectClass}
                      value={sponsor}
                      onChange={(event) => setSponsor(event.target.value)}
                    >
                      <option>Dotta</option>
                      <option>Alex</option>
                    </select>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Permission profile: Restricted. {sponsor} is responsible for
                    this person’s requests. Automatic reviews start off;
                    personal credentials and membership are not shared.
                  </p>
                  {alreadyAdded && (
                    <p role="status" className="text-sm">
                      This GitHub user already has access.
                    </p>
                  )}
                  <Button disabled={alreadyAdded} onClick={add}>
                    Allow this GitHub user
                  </Button>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

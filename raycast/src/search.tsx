import {
  Action,
  ActionPanel,
  Color,
  Form,
  getPreferenceValues,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  trash,
  useNavigation,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useState } from "react";
import { editItem, expandHome, forgetItem, type Item, type Library, loadLibrary } from "./library";
import { applyToken, matches, noteText, parseNote, parseQuery, suggest } from "./query";

const MAX_SUGGESTIONS = 5;

type Suggestion = { kind: "@" | "#"; name: string; count: number };

export default function Command() {
  const { libraryPath } = getPreferenceValues<Preferences.Search>();
  const root = expandHome(libraryPath || "~/Pictures/Screen Utils");
  const { data: lib, isLoading, revalidate } = useCachedPromise(loadLibrary, [root], { keepPreviousData: true });
  const [searchText, setSearchText] = useState("");
  const [showingDetail, setShowingDetail] = useState(true);

  const query = useMemo(() => parseQuery(searchText), [searchText]);
  const results = useMemo(() => (lib ? lib.items.filter((item) => matches(item, query)) : []), [lib, query]);

  // Folders and tags to pick: for a half-typed @ or #, or a word that
  // names one. Picking one turns it into a filter in the search text.
  const suggestions = useMemo((): Suggestion[] => {
    if (!lib || !query.last) return [];
    const { kind, text } = query.last;
    const count = (s: Omit<Suggestion, "count">) =>
      lib.items.filter((i) =>
        s.kind === "@" ? i.folder === s.name : i.tags.some((t) => t.toLowerCase() === s.name.toLowerCase()),
      ).length;
    const pick = (k: "@" | "#") =>
      suggest(k === "@" ? lib.folders : lib.tags, text, k === "@" ? query.folders : query.tags).map((name) => ({
        kind: k,
        name,
      }));
    let found: Omit<Suggestion, "count">[];
    if (kind) found = pick(kind);
    else if (text.length >= 2) found = [...pick("@"), ...pick("#")];
    else found = [];
    return found.slice(0, MAX_SUGGESTIONS).map((s) => ({ ...s, count: count(s) }));
  }, [lib, query]);

  const sections = useMemo(() => groupByDate(results), [results]);
  const applySuggestion = (s: Suggestion) => setSearchText(applyToken(searchText, s.kind, s.name));

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showingDetail && results.length > 0}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search notes and text, @folder, #tag"
    >
      {suggestions.length > 0 && (
        <List.Section title={query.last?.kind === "#" ? "Tags" : query.last?.kind === "@" ? "Folders" : "Filters"}>
          {suggestions.map((s) => (
            <List.Item
              key={`${s.kind}${s.name}`}
              icon={
                s.kind === "@"
                  ? { source: Icon.Folder, tintColor: Color.Blue }
                  : { source: Icon.Hashtag, tintColor: Color.Yellow }
              }
              title={s.name}
              accessories={showingDetail ? undefined : [{ text: String(s.count) }]}
              detail={<List.Item.Detail markdown={`**${s.kind}${s.name}**\n\n${plural(s.count, "item")}`} />}
              actions={
                <ActionPanel>
                  <Action
                    title={s.kind === "@" ? "Filter by Folder" : "Filter by Tag"}
                    icon={Icon.Filter}
                    onAction={() => applySuggestion(s)}
                  />
                  {s.kind === "@" && lib && <Action.ShowInFinder path={`${lib.root}/${s.name}`} />}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {sections.map(([title, items]) => (
        <List.Section key={title} title={title}>
          {items.map((item) => (
            <ItemRow
              key={item.path}
              item={item}
              lib={lib!}
              showingDetail={showingDetail}
              toggleDetail={() => setShowingDetail((v) => !v)}
              filterFolder={(folder) => setSearchText(applyToken("", "@", folder))}
              reload={revalidate}
            />
          ))}
        </List.Section>
      ))}
      {!isLoading && results.length === 0 && suggestions.length === 0 && (
        <List.EmptyView
          icon={Icon.Image}
          title={lib?.items.length ? "No matches" : "No screenshots yet"}
          description={lib?.items.length ? undefined : "Press ⌥⇧S to take one"}
        />
      )}
    </List>
  );
}

function ItemRow(props: {
  item: Item;
  lib: Library;
  showingDetail: boolean;
  toggleDetail: () => void;
  filterFolder: (folder: string) => void;
  reload: () => void;
}) {
  const { item, lib, showingDetail } = props;
  const title = item.note || item.name.replace(/\.[^.]+$/, "");
  const subtitle = [item.folder ? `@${item.folder}` : "", ...item.tags.map((t) => `#${t}`)].filter(Boolean).join("  ");

  const remove = async () => {
    try {
      await trash(item.path);
      await forgetItem(lib, item);
      await showToast({ style: Toast.Style.Success, title: "Moved to Trash" });
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Could not delete", message: String(error) });
    }
    props.reload();
  };

  return (
    <List.Item
      icon={{ source: item.path }}
      title={title}
      subtitle={showingDetail ? undefined : subtitle}
      accessories={showingDetail ? undefined : [{ date: new Date(item.createdAt) }]}
      quickLook={{ path: item.path, name: title }}
      detail={<ItemDetail item={item} />}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.Paste title="Paste Image" content={{ file: item.path }} />
            <Action.CopyToClipboard
              title="Copy Image"
              content={{ file: item.path }}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
            <Action.ToggleQuickLook shortcut={Keyboard.Shortcut.Common.ToggleQuickLook} />
            <Action
              title={showingDetail ? "Hide Preview" : "Show Preview"}
              icon={Icon.Sidebar}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
              onAction={props.toggleDetail}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.Push
              title="Edit Note"
              icon={Icon.Pencil}
              shortcut={Keyboard.Shortcut.Common.Edit}
              target={<EditNote item={item} lib={lib} onSaved={props.reload} />}
            />
            {item.folder && (
              <Action
                title={`Show Only @${item.folder}`}
                icon={Icon.Filter}
                shortcut={{ modifiers: ["cmd"], key: "f" }}
                onAction={() => props.filterFolder(item.folder!)}
              />
            )}
            <Action.Open title="Open" target={item.path} shortcut={Keyboard.Shortcut.Common.Open} />
            <Action.ShowInFinder path={item.path} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }} />
            <Action.CopyToClipboard
              title="Copy Path"
              content={item.path}
              shortcut={{ modifiers: ["cmd", "shift"], key: "." }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Delete"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={remove}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function ItemDetail({ item }: { item: Item }) {
  // Spaces and parentheses would end the Markdown link early.
  const src = encodeURI(`file://${item.path}`).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return (
    <List.Item.Detail
      markdown={`![](${src})`}
      metadata={
        <List.Item.Detail.Metadata>
          {item.note && <List.Item.Detail.Metadata.Label title="Note" text={item.note} />}
          {item.folder && <List.Item.Detail.Metadata.Label title="Folder" text={item.folder} icon={Icon.Folder} />}
          {item.tags.length > 0 && (
            <List.Item.Detail.Metadata.TagList title="Tags">
              {item.tags.map((t) => (
                <List.Item.Detail.Metadata.TagList.Item key={t} text={t} color={Color.Yellow} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          )}
          <List.Item.Detail.Metadata.Label
            title={item.kind === "drawing" ? "Drawn" : "Taken"}
            text={new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          />
          {item.width && item.height && (
            <List.Item.Detail.Metadata.Label title="Size" text={`${item.width} × ${item.height}`} />
          )}
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function EditNote(props: { item: Item; lib: Library; onSaved: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Edit Note"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={async (values: { text: string }) => {
              try {
                await editItem(props.lib, props.item, parseNote(values.text));
                props.onSaved();
                pop();
              } catch (error) {
                await showToast({ style: Toast.Style.Failure, title: "Could not save", message: String(error) });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="text" title="Note" defaultValue={noteText(props.item)} placeholder="Note  @folder  #tag" />
    </Form>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function groupByDate(items: Item[]): [string, Item[]][] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86400000;
  const label = (ms: number) => {
    if (ms >= today) return "Today";
    if (ms >= today - day) return "Yesterday";
    if (ms >= today - 6 * day) return "This Week";
    return new Date(ms).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };
  const groups: [string, Item[]][] = [];
  for (const item of items) {
    const title = label(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === title) last[1].push(item);
    else groups.push([title, [item]]);
  }
  return groups;
}

<!--
  DeleteHistoryDialog — confirmation for the irreversible history delete.

  The numbers it shows are read from the backend before the dialog opens, not
  estimated from whatever the charts happen to hold: this action drops every
  persisted row, including the ones outside the range on screen.
-->
<script lang="ts">
  import { AlertTriangle, Loader2 } from 'lucide-svelte';
  import ModalFrame from '$lib/components/models/ModalFrame.svelte';
  import { Button } from '$lib/components/ui/button';
  import { formatTooltipTimestamp } from '$lib/utils/chart';
  import type { MetricsHistorySummary } from '$lib/types';

  export let open = false;
  /** null when the pre-flight read failed; the dialog says so rather than guessing. */
  export let summary: MetricsHistorySummary | null = null;
  export let busy = false;
  export let onConfirm: () => void = () => {};
  export let onCancel: () => void = () => {};

  $: totalRows = summary ? summary.tasks + summary.hardware : 0;
  /** The oldest record of either kind: how far back the delete reaches. */
  $: oldest = summary
    ? [summary.oldest_task, summary.oldest_hardware]
        .filter((value): value is string => Boolean(value))
        .sort()[0]
    : undefined;
</script>

<!--
  No `description`: ModalFrame breaks that line mid-word so long model names
  cannot overflow it, which mangles a prose sentence. The warning goes in the
  body instead.
-->
<ModalFrame
  {open}
  title="Delete history"
  widthClass="sm:max-w-[460px]"
  on:close={onCancel}
>
  <div class="space-y-3 py-1">
    <p class="text-sm text-muted-foreground">
      This permanently removes the persisted metrics history. It cannot be undone.
    </p>
    {#if summary}
      <div class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div class="text-xs text-destructive">
          <p>
            About to delete
            <span class="ops-mono">{summary.tasks}</span>
            task {summary.tasks === 1 ? 'record' : 'records'} and
            <span class="ops-mono">{summary.hardware}</span>
            hardware {summary.hardware === 1 ? 'sample' : 'samples'}.
          </p>
          {#if oldest}
            <p class="mt-1">
              The oldest was recorded {formatTooltipTimestamp(oldest)}.
            </p>
          {/if}
        </div>
      </div>

      {#if totalRows === 0}
        <p class="text-xs text-muted-foreground">
          There is nothing stored to delete.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">
          Every range in History reads from these rows, not just the one on screen.
          Export CSV first if you need them.
        </p>
      {/if}
    {:else}
      <div class="flex items-start gap-2 rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-2">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
        <p class="text-xs text-status-warn">
          Could not read what is stored, so the amount about to be deleted is unknown.
          The delete itself would still remove every persisted row.
        </p>
      </div>
    {/if}
  </div>

  <div class="mt-5 flex items-center justify-end gap-2">
    <Button variant="outline" on:click={onCancel} disabled={busy}>Cancel</Button>
    <Button variant="destructive" on:click={onConfirm} disabled={busy}>
      {#if busy}
        <Loader2 class="mr-2 h-4 w-4 animate-spin" /> Deleting…
      {:else}
        Delete permanently
      {/if}
    </Button>
  </div>
</ModalFrame>

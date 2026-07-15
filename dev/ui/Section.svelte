<script lang="ts">
  import type { Snippet } from 'svelte'

  let { label, children }: { label: string; children: Snippet } = $props()
</script>

<div style="display:flex; align-items:center; gap:6px; margin-bottom:8px; flex-wrap:wrap;">
  <span style="font-size:10px; color:var(--fg-30); width:56px; flex-shrink:0; text-transform:uppercase; letter-spacing:0.5px;">
    {label}
  </span>
  {@render children()}
</div>

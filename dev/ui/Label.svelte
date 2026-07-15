<script lang="ts">
  import type { Snippet } from 'svelte'

  let { text, children }: { text: string; children: Snippet } = $props()
</script>

<div style="display:flex; align-items:center; gap:4px;">
  <span style="font-size:10px; color:var(--fg-20); margin-right:2px;">{text}:</span>
  {@render children()}
</div>

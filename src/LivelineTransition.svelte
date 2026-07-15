<!--
  Cross-fade between chart components (e.g. line <-> candlestick).
  Declare one named snippet per possible `active` value.

  @example
  ```svelte
  <LivelineTransition active={chartType}>
    {#snippet line()}
      <Liveline data={data} value={value} />
    {/snippet}
    {#snippet candle()}
      <Liveline mode="candle" candles={candles} candleWidth={5} data={data} value={value} />
    {/snippet}
  </LivelineTransition>
  ```
-->
<script lang="ts">
  import { fade } from 'svelte/transition'
  import { cubicInOut } from 'svelte/easing'
  import type { Snippet } from 'svelte'
  import type { LivelineTransitionProps } from './types.js'

  let {
    active,
    duration = 300,
    class: className,
    style,
    ...snippets
  }: LivelineTransitionProps = $props()

  const views = $derived(snippets as Record<string, Snippet | undefined>)
</script>

<div class={className} style="position:relative; width:100%; height:100%;{style ? ` ${style}` : ''}">
  <!-- Keyed each: when `active` changes, the outgoing view fades out while
       the incoming one fades in — both stay mounted for the duration. -->
  {#each [active] as key (key)}
    <div style="position:absolute; inset:0;" transition:fade={{ duration, easing: cubicInOut }}>
      {@render views[key]?.()}
    </div>
  {/each}
</div>

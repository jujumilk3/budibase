<script>
  import { Body } from "@budibase/bbui"
  import CreationPage from "components/common/CreationPage.svelte"
  import blankImage from "./images/blank.png"
  import tableImage from "./images/table.png"
  import gridImage from "./images/grid.png"
  import formImage from "./images/form.png"
  import CreateScreenModal from "./CreateScreenModal.svelte"
  import { screenStore } from "stores/builder"

  export let onClose = null

  let createScreenModal

  $: hasScreens = $screenStore.screens?.length
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="page">
  <CreationPage
    showClose={!!onClose}
    {onClose}
    heading={hasScreens ? "Create new screen" : "Create your first screen"}
  >
    <div class="subHeading">
      <Body>Start from scratch or create screens from your data</Body>
    </div>

    <div class="cards">
      <div class="card" on:click={() => createScreenModal.show("blank")}>
        <div class="image">
          <img alt="" src={blankImage} />
        </div>
        <div class="text">
          <Body size="S">Blank screen</Body>
          <Body size="XS">Add an empty blank screen</Body>
        </div>
      </div>

      <div class="card" on:click={() => createScreenModal.show("table")}>
        <div class="image">
          <img alt="" src={tableImage} />
        </div>
        <div class="text">
          <Body size="S">Table</Body>
          <Body size="XS">View, edit and delete rows on a table</Body>
        </div>
      </div>

      <div class="card" on:click={() => createScreenModal.show("grid")}>
        <div class="image">
          <img alt="" src={gridImage} />
        </div>
        <div class="text">
          <Body size="S">Grid</Body>
          <Body size="XS">View and manipulate rows on a grid</Body>
        </div>
      </div>

      <div class="card" on:click={() => createScreenModal.show("form")}>
        <div class="image">
          <img alt="" src={formImage} />
        </div>
        <div class="text">
          <Body size="S">Form</Body>
          <Body size="XS">Capture data from your users</Body>
        </div>
      </div>
    </div>
  </CreationPage>
</div>

<CreateScreenModal bind:this={createScreenModal} />

<style>
  .page {
    padding: 28px 40px 40px 40px;
  }

  .subHeading :global(p) {
    text-align: center;
    margin-top: 12px;
    margin-bottom: 36px;
    color: var(--spectrum-global-color-gray-600);
  }

  .cards {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 24px;
  }

  .card {
    max-width: 235px;
    transition: filter 150ms;
  }

  .card:hover {
    filter: brightness(1.1);
    cursor: pointer;
  }

  .image {
    border-radius: 4px 4px 0 0;
    width: 100%;
    max-height: 127px;
    overflow: hidden;
  }

  .image img {
    width: 100%;
  }

  .text {
    border: 1px solid var(--grey-4);
    border-radius: 0 0 4px 4px;
    padding: 8px 16px 13px 16px;
  }

  .text :global(p:nth-child(1)) {
    margin-bottom: 6px;
  }

  .text :global(p:nth-child(2)) {
    color: var(--grey-6);
  }
</style>

import { useIsNarrowViewport } from './useIsNarrowViewport';

/**
 * useGridPagination — the ONE place a paginated AG Grid decides its page size
 * (and whether it offers a page-size picker). Spread the result onto
 * <AgGridReact>:   {...useGridPagination(50, [25, 50, 100])}
 *
 * Below MOBILE_PAGINATION_MAX_WIDTH the pagination footer is not shown
 * (index.css hides `.ag-paging-panel` at `max-width: 767px`): the grid is one
 * continuously-scrolling list. A footer-less grid must therefore hold EVERY
 * row on its single page — a finite page size there leaves rows 51..N with no
 * control to reach them. The grid's `pagination` flag itself stays on (turning
 * it off desyncs AG Grid's row-count model), so "one page" is expressed as a
 * page size no dataset can reach; rows are still virtualized, so only the
 * visible ones are in the DOM. The page-size picker is switched off there too:
 * it lives in the hidden footer, and a page size that is not one of its
 * options makes AG Grid log a warning on every load.
 *
 * The breakpoint here and the CSS rule MUST stay equal — they used to differ
 * (page size switched at 480px, footer hid at 767px), which left 481-767px
 * viewports with a hidden footer and only the first page of rows reachable.
 */
export const MOBILE_PAGINATION_MAX_WIDTH = 767; // keep in sync with the .ag-paging-panel rule in index.css
export const SINGLE_PAGE_SIZE = 1000000;

export function useGridPagination(desktopPageSize, desktopPageSizeSelector = true) {
  const footerHidden = useIsNarrowViewport(MOBILE_PAGINATION_MAX_WIDTH);
  return footerHidden
    ? { paginationPageSize: SINGLE_PAGE_SIZE, paginationPageSizeSelector: false }
    : { paginationPageSize: desktopPageSize, paginationPageSizeSelector: desktopPageSizeSelector };
}

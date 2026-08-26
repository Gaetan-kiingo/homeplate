// client/src/api/types.js — U5-API-CLIENT: JSDoc typedefs for the payload shapes the API
// actually serves, transcribed from the backend's allowlist serializers on this tree
// (build-plan §6.1 5B behaviour 4). No runtime code — shape documentation the endpoint
// modules and wave-6 screens reference.
//
// Requirement / decision traceability (SRS Appendix B):
//   ADR-010 / NFR-13 / AB-08 — the PUBLIC listing shape (src/modules/listings/serializers.js
//     publicListing) is the DEFAULT everywhere: coarsened coordinates (coarseLat/coarseLng)
//     + areaLabel + city-level text ONLY. The precise fields (addressLine1/2, postalCode,
//     lat, lng) are OPTIONAL and present only on the privileged projection — the listing's
//     own host, a guest holding a pending/in-progress booking on it, or a moderator handling
//     an FR-07 alert. NO CLIENT CODE MAY ASSUME A PRECISE FIELD EXISTS: render from the
//     coarse fields and treat the precise ones as a conditional bonus. The same discipline
//     applies to the host shapes (HOST_SUMMARY_KEYS: display identity + review aggregates,
//     never contact data, never any address key).

/**
 * One attached image, URL derived server-side from the object-storage key (ADR-004).
 * @typedef {object} ListingImage
 * @property {string} id
 * @property {string} url
 * @property {?string} contentType
 */

/**
 * The ADR-010 PUBLIC listing projection — the DEFAULT shape on every read path (search
 * results, listing detail, host-page example dishes). Location context is COARSE only.
 * @typedef {object} PublicListing
 * @property {string} id
 * @property {string} hostId
 * @property {string} title
 * @property {string} description
 * @property {string} ingredients
 * @property {string} allergens
 * @property {?string} cuisine
 * @property {string} scheduledStart  ISO 8601 instant
 * @property {number} durationMinutes
 * @property {?string} localDate      'YYYY-MM-DD' MEHKO calendar day (America/Los_Angeles)
 * @property {?string} city
 * @property {?string} region
 * @property {?string} country
 * @property {?number} coarseLat      coarsened latitude (ADR-010 — NOT the host's address)
 * @property {?number} coarseLng      coarsened longitude
 * @property {?string} areaLabel      neighbourhood/city label for display
 * @property {number} seatCapacity
 * @property {number} seatsRemaining
 * @property {string} status
 * @property {string} moderationStatus
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {ListingImage[]} images
 */

/**
 * The privileged projection: PublicListing PLUS the exact address/coordinates. Served ONLY
 * to the listing's own host, a guest with a pending/in-progress booking on it, or a
 * moderator on an FR-07 alert (ADR-010). Every precise field is optional by construction —
 * code must feature-test (`listing.addressLine1 != null`), never assume.
 * @typedef {PublicListing & {
 *   addressLine1?: ?string,
 *   addressLine2?: ?string,
 *   postalCode?: ?string,
 *   lat?: ?number,
 *   lng?: ?number,
 * }} MaybePrivilegedListing
 */

/**
 * Host summary attached to listing detail (HOST_SUMMARY_KEYS allowlist): display identity
 * and review aggregates only — never contact data, never any address or location key.
 * @typedef {object} HostSummary
 * @property {string} displayName
 * @property {?string} bio
 * @property {?number} averageRating
 * @property {number} reviewCount
 */

/**
 * GET /api/listings/:id payload — the listing projection plus detail-only context
 * (DETAIL_CONTEXT_KEYS). `reviewsTotal > reviews.length` means further pages exist at
 * GET /api/hosts/:id/reviews.
 * @typedef {MaybePrivilegedListing & {
 *   host: HostSummary,
 *   reviews: object[],
 *   reviewsTotal: number,
 *   reviewsPageSize: number,
 * }} ListingDetail
 */

/**
 * The authenticated user's OWN profile (src/modules/users/repo.js serializeUser — the owner
 * sees their own decrypted contact fields; nobody else's profile is ever served this way).
 * @typedef {object} SessionUser
 * @property {string} id
 * @property {string} email
 * @property {boolean} emailVerified
 * @property {string} fullName
 * @property {?string} phone
 * @property {?object} emergencyContact
 * @property {boolean} canReserveSeat    FR-09 eligibility flags — display only; the ONE
 * @property {boolean} canPublishListing server-side policy remains the enforcement point
 * @property {string[]} roles
 * @property {?{bio: ?string, hostAgreementAcceptedAt: ?string}} hostProfile
 * @property {string} createdAt
 */

/**
 * api.search() result — NFR-09 degraded mode is a STATE, never an exception:
 *   'ok'          → 200                        (fresh answer)
 *   'degraded'    → 200 + degraded: true       (stale-cache answer during a provider outage)
 *   'unavailable' → typed 503 SEARCH_DEGRADED  (no answer; `error.message` is user-facing)
 * @typedef {object} SearchResult
 * @property {'ok'|'degraded'|'unavailable'} state
 * @property {PublicListing[]} [listings]  present for 'ok' and 'degraded'
 * @property {number} [page]
 * @property {number} [pageSize]
 * @property {number} [total]
 * @property {import('./errors.js').ApiError} [error]  present for 'unavailable' only
 */

export {};

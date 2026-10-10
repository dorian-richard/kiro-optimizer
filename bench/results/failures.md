# kopt bench: failure analysis (kopt-pack)

30 of 138 tasks missed by `kopt-pack` · input = `search` · 2026-10-09T22:39:50.626Z

Every missed gold item is classified mechanically from the index (see `src/bench/failures.ts`):

- **(c) extraction gap**: the gold file is not indexed, or no indexed symbol with the gold name covers the gold line.
- **(b) unresolved references** (usage/impact): the gold caller has no reference to the target, or it is unresolved.
- **(d) budget / format**: the gold name is shown without its path (callers line), or the item appears with 4x the pack budget.
- **(e) multi-step**: one hop away from a shown symbol (resolved reference) while the query words do not describe it, or a
  caller of a shown target (one `kopt_refs` call away).
- **(a) ranking / natural-language mismatch**: everything else; the item is indexed and reachable but ranked out of the pack.

A task's primary cause is its most severe item cause: c > b > a > e > d.

## Missed tasks per primary cause

| language | repo | missed / tasks | (a) ranking / natural-language mismatch | (b) unresolved references | (c) extraction gap | (d) budget / format | (e) needs multi-step exploration |
|---|---|---|---|---|---|---|---|
| java | spring-framework | 4/15 | 1 | · | · | 3 | · |
| python | django | 2/15 | 1 | · | · | · | 1 |
| typescript | medusa | 3/12 | · | 1 | · | 1 | 1 |
| javascript | webpack | 1/12 | · | 1 | · | · | · |
| c_sharp | jellyfin | 2/12 | · | · | · | 1 | 1 |
| go | gitea | 1/12 | · | · | · | · | 1 |
| kotlin | exposed | 4/12 | 1 | · | · | · | 3 |
| rust | meilisearch | 5/12 | · | 2 | 1 | 2 | · |
| php | laravel | 3/12 | · | · | · | 2 | 1 |
| ruby | discourse | 1/12 | 1 | · | · | · | · |
| scala | playframework | 4/12 | 2 | · | 1 | · | 1 |
| **all** |  | **30/138** | **6** | **4** | **2** | **9** | **9** |

## Missed gold items per cause

| language | repo | (a) ranking / natural-language mismatch | (b) unresolved references | (c) extraction gap | (d) budget / format | (e) needs multi-step exploration |
|---|---|---|---|---|---|---|
| java | spring-framework | 1 | · | · | 5 | · |
| python | django | 1 | · | · | · | 1 |
| typescript | medusa | · | 1 | · | 2 | 2 |
| javascript | webpack | · | 2 | · | · | · |
| c_sharp | jellyfin | · | · | · | 3 | 1 |
| go | gitea | · | · | · | · | 2 |
| kotlin | exposed | 1 | · | · | 3 | 3 |
| rust | meilisearch | · | 7 | 2 | 5 | · |
| php | laravel | · | · | · | 3 | 1 |
| ruby | discourse | 1 | · | · | · | · |
| scala | playframework | 2 | 1 | 1 | · | 1 |
| **all** |  | **6** | **11** | **3** | **21** | **11** |

## java: spring-framework (4 missed of 15)

### sf-locate-retry-loop (locate) — (d) budget / format

- query: `retry loop back off attempts timeout exceeded` · 1327 tok
- kopt returned: `backoff/FixedBackOff.java:29-150 public class FixedBackOff implements BackOff`; `backoff/BackOffExecution.java:43-43 long nextBackOff()`; `retry/RetryPolicy.java:221-225 public Builder backOff(BackOff backOff)`; `retry/RetryPolicy.java:83-85 default BackOff getBackOff()`; `retry/RetryPolicy.java:356-360 public Builder timeout(Duration timeout)`
- callers line: `callers of #ulr FixedBackOff (+3 related decls) · 32 refs in 7 files · complete:`
- top candidate: `org.springframework.util.backoff.FixedBackOff` (class, spring-core/src/main/java/org/springframework/util/backoff/FixedBackOff.java:29-150, query coverage 57%)
- expected: `RetryTemplate`, `execute`, `checkIfTimeoutExceeded` in `spring-core/src/main/java/org/springframework/core/retry/RetryTemplate.java`
- missed: `execute`
  - `execute` RetryTemplate.java:126: (d) shown with a 4x budget (rank 111, after diversification 52)

### sf-locate-api-version (locate) — (d) budget / format

- query: `api version request resolve parse validate handler mapping` · 1480 tok
- kopt returned: `accept/ApiVersionStrategy.java:91-116 default Mono<Comparable<?>> resolveParseAndValidateApiVersio`; `accept/ApiVersionStrategy.java:125-142 @Deprecated(since = "7.0.3", forRemoval = true) default @Nul`; `accept/ApiVersionStrategy.java:71-87 default @Nullable Comparable<?> resolveParseAndValidateVersi`; `config/WebFluxConfigurationSupport.java:136-155 @Bean public RequestMappingHandlerMapping requestMappingHand`; `accept/ApiVersionHolder.java:36-84 public final class ApiVersionHolder`
- callers line: `callers of #2p36 ApiVersionStrategy.resolveParseAndValidateApiVersion · 2 refs in 2 files · complete:`
- top candidate: `org.springframework.web.reactive.accept.ApiVersionStrategy.resolveParseAndValidateApiVersion` (method, spring-webflux/src/main/java/org/springframework/web/reactive/accept/ApiVersionStrategy.java:91-116, query coverage 75%)
- expected: `resolveParseAndValidateVersion`, `DefaultApiVersionStrategy`, `validateVersion`, `initApiVersion` in `spring-web/src/main/java/org/springframework/web/accept/ApiVersionStrategy.java`, `spring-web/src/main/java/org/springframework/web/accept/DefaultApiVersionStrategy.java`, `spring-webmvc/src/main/java/org/springframework/web/servlet/handler/AbstractHandlerMapping.java`
- missed: `AbstractHandlerMapping.java` (path)
  - `initApiVersion` AbstractHandlerMapping.java:593: (d) shown with a 4x budget (rank 14, after diversification 14)

### sf-explain-retryable (explain) — (d) budget / format

- query: `Retryable annotation retry interceptor retry policy` · 1352 tok
- kopt returned: `annotation/Retryable.java:55-297 @Target({ElementType.TYPE, ElementType.METHOD}) @Retention(R`; `annotation/RetryAnnotationBeanPostProcessor.java:55-178 @SuppressWarnings("serial") public class RetryAnnotationBean`; `annotation/RetryAnnotationBeanPostProcessor.java:84-176 private class RetryAnnotationInterceptor extends AbstractRet`; `retry/RetryListener.java:109-110 default void onRetryPolicyExhaustion(RetryPolicy retryPolicy`; `retry/RetryListener.java:137-138 default void onRetryPolicyTimeout(RetryPolicy retryPolicy, R`
- callers line: `callers of #ctc Retryable · 45 refs in 3 files · 8 unresolved same-name refs:`
- top candidate: `org.springframework.resilience.annotation.Retryable` (interface, spring-context/src/main/java/org/springframework/resilience/annotation/Retryable.java:55-297, query coverage 80%)
- expected: `RetryAnnotationBeanPostProcessor`, `getRetrySpec`, `AbstractRetryInterceptor`, `RetryTemplate` in `spring-context/src/main/java/org/springframework/resilience/annotation/RetryAnnotationBeanPostProcessor.java`, `spring-context/src/main/java/org/springframework/resilience/retry/AbstractRetryInterceptor.java`, `spring-core/src/main/java/org/springframework/core/retry/RetryTemplate.java`
- missed: `RetryTemplate`, `AbstractRetryInterceptor.java` (path), `RetryTemplate.java` (path)
  - `AbstractRetryInterceptor` AbstractRetryInterceptor.java:57: (d) shown with a 4x budget (rank 30, after diversification 25)
  - `RetryTemplate` RetryTemplate.java:56: (d) shown with a 4x budget (rank 17, after diversification 17)

### sf-explain-config-full-lite (explain) — (a) ranking / natural-language mismatch (also (d))

- query: `configuration class full lite proxyBeanMethods enhance cglib` · 1317 tok
- kopt returned: `annotation/Configuration.java:477-477 boolean proxyBeanMethods() default true`; `annotation/ConfigurationClassEnhancer.java:78-617 class ConfigurationClassEnhancer`; `annotation/ConfigurationClassEnhancer.java:572-614 private Object createCglibProxyForFactoryBean(Object factory`; `annotation/ConfigurationClassEnhancer.java:102-140 public Class<?> enhance(Class<?> configClass, @Nullable Clas`; `annotation/ConfigurationClassEnhancer.java:227-228 ConfigurationClassEnhancer.EnhancedConfiguration`
- callers line: `callers of #r1f ConfigurationClass (+5 related decls) · 102 refs in 8 files · complete:`
- top candidate: `org.springframework.context.annotation.Configuration.proxyBeanMethods` (method, spring-context/src/main/java/org/springframework/context/annotation/Configuration.java:477-477, query coverage 56%)
- expected: `checkConfigurationClassCandidate`, `enhanceConfigurationClasses`, `ConfigurationClassEnhancer`, `enhance` in `spring-context/src/main/java/org/springframework/context/annotation/ConfigurationClassUtils.java`, `spring-context/src/main/java/org/springframework/context/annotation/ConfigurationClassPostProcessor.java`, `spring-context/src/main/java/org/springframework/context/annotation/ConfigurationClassEnhancer.java`
- missed: `checkConfigurationClassCandidate`, `enhanceConfigurationClasses`, `ConfigurationClassUtils.java` (path), `ConfigurationClassPostProcessor.java` (path)
  - `checkConfigurationClassCandidate` ConfigurationClassUtils.java:106: (a) ranked 423 of 514 candidates (pack lists 12 pointers; below the weak-tail cut: score 14% of the top); query words cover 22% of it; top candidate org.springframework.context.annotation.Configuration.proxyBeanMethods covers 56%; query word(s) "class" dropped as stopwords although part of the name
  - `enhanceConfigurationClasses` ConfigurationClassPostProcessor.java:514: (d) shown with a 4x budget (rank 15, after diversification 15)

## python: django (2 missed of 15)

### dj-explain-password-upgrade (explain) — (e) needs multi-step exploration

- query: `check password hasher must update iterations rehash` · 1246 tok
- kopt returned: `auth/hashers.py:361-364 def must_update(self, encoded)`; `auth/hashers.py:297-298 def must_update(self, encoded)`; `auth/hashers.py:75-86 def check_password(password, encoded, setter=None, preferred`; `auth/hashers.py:316-370 class PBKDF2PasswordHasher(BasePasswordHasher)`; `auth/hashers.py:209-313 class BasePasswordHasher`
- callers line: `callers of #at7 PBKDF2PasswordHasher.must_update (+1 related decl) · 5 refs in 2 files · complete:`
- top candidate: `django.contrib.auth.hashers.PBKDF2PasswordHasher.must_update` (method, django/contrib/auth/hashers.py:361-364, query coverage 57%)
- expected: `check_password`, `verify_password`, `identify_hasher`, `must_update` in `django/contrib/auth/hashers.py`
- missed: `identify_hasher`
  - `identify_hasher` hashers.py:172: (e) query words cover 29% of it; reachable in one hop from shown #asb verify_password (the shown symbol references it)

### dj-explain-autoreload-stat (explain) — (a) ranking / natural-language mismatch

- query: `autoreload reloader detect file changes without watchman` · 1291 tok
- kopt returned: `utils/autoreload.py:448-655 class WatchmanReloader(BaseReloader)`; `utils/autoreload.py:386-390 def notify_file_changed(self, path)`; `utils/autoreload.py:658-664 def get_reloader()`; `utils/autoreload.py:444-445 class WatchmanUnavailable(RuntimeError)`; `utils/autoreload.py:295-398 class BaseReloader`
- callers line: `callers of #5wl WatchmanReloader (+1 related decl) · 12 refs in 2 files · complete:`
- top candidate: `django.utils.autoreload.WatchmanReloader` (class, django/utils/autoreload.py:448-655, query coverage 50%)
- expected: `get_reloader`, `StatReloader`, `tick`, `snapshot_files` in `django/utils/autoreload.py`
- missed: `snapshot_files`
  - `snapshot_files` autoreload.py:425: (a) not a candidate at all (no FTS/name match); query words cover 33% of it

## typescript: medusa (3 missed of 12)

### md-explain-compensation (explain) — (e) needs multi-step exploration (also (d))

- query: `workflow transaction step permanent failure compensate rollback` · 1373 tok
- kopt returned: `helpers/step-response.ts:120-128 static permanentFailure( message = "Permanent failure", comp`; `transaction/errors.ts:17-30 export class PermanentStepFailureError extends BaseStepErrro`; `transaction/errors.ts:18-25 static isPermanentStepFailureError( error: Error ): error is`; `workflow/local-workflow.ts:496-525 async registerStepFailure( idempotencyKey: string, error?: E`; `workflow-executions/types.ts:6-6 PERMANENT_FAILURE = "permanent_failure"`
- callers line: `callers of #iwn StepResponse.permanentFailure · 1 ref in 1 file · complete:`
- top candidate: `StepResponse.permanentFailure` (method, packages/core/workflows-sdk/src/utils/composer/helpers/step-response.ts:120-128, query coverage 71%)
- expected: `setStepFailure`, `checkAllSteps`, `flagStepsToRevert`, `getCompensationSteps` in `packages/core/orchestration/src/transaction/transaction-orchestrator.ts`
- missed: `checkAllSteps`, `flagStepsToRevert`, `getCompensationSteps`
  - `checkAllSteps` transaction-orchestrator.ts:324: (e) query words cover 29% of it; reachable in one hop from shown #8g7 computeCurrentTransactionState (it references the shown symbol)
  - `flagStepsToRevert` transaction-orchestrator.ts:523: (d) shown with a 4x budget (rank 97, after diversification none)
  - `getCompensationSteps` transaction-orchestrator.ts:191: (e) query words cover 29% of it; reachable in one hop from shown #8g7 computeCurrentTransactionState (the shown symbol references it)

### md-explain-price-lists (explain) — (d) budget / format

- query: `pricing calculated price original price price list sale override` · 1386 tok
- kopt returned: `common/price-list.ts:24-24 export type PriceListType = "sale" \| "override"`; `common/price-set.ts:141-141 is_original_price_price_list?: boolean`; `common/price-set.ts:188-209 original_price?: { /** * The ID of the price selected as the`; `common/price-set.ts:117-210 export interface CalculatedPriceSet`; `utils/prepare-line-item-data.ts:62-69 calculated_price: { calculated_price: { price_list_type: str`
- callers line: `callers of #fk1 PriceListType · 7 refs in 3 files · 1 unresolved same-name ref:`
- top candidate: `PriceListType` (type, packages/core/types/src/pricing/common/price-list.ts:24-24, query coverage 71%)
- expected: `calculatePrices`, `calculatePrices`, `PricingModuleService` in `packages/modules/pricing/src/services/pricing-module.ts`, `packages/modules/pricing/src/repositories/pricing.ts`
- missed: `pricing.ts` (path)
  - `calculatePrices` pricing.ts:66: (d) shown with a 4x budget (rank 19, after diversification 19)

### md-impact-budget-exceeded (impact) — (b) unresolved references

- query: `computeActionForBudgetExceeded campaign budget` · 865 tok
- kopt returned: `compute-actions/usage.ts:27-60 export function computeActionForBudgetExceeded( promotion: P`; `common/compute-actions.ts:33-43 export interface CampaignBudgetExceededAction`; `common/compute-actions.ts:37-37 action: "campaignBudgetExceeded"`; `promotion/index.ts:51-51 CAMPAIGN_BUDGET_EXCEEDED = "campaignBudgetExceeded"`
- callers line: `callers of #pk8 computeActionForBudgetExceeded · 6 refs in 3 files · 1 unresolved same-name ref:`
- top candidate: `computeActionForBudgetExceeded` (function, packages/modules/promotion/src/utils/compute-actions/usage.ts:27-60, query coverage 100%)
- expected: `computeActionForBudgetExceeded`, `computeActions`, `applyPromotionToTargetItems`, `applyPromotionToItems`, `applyPromotionToShippingMethods` in `packages/modules/promotion/src/utils/compute-actions/usage.ts`, `packages/modules/promotion/src/services/promotion-module.ts`, `packages/modules/promotion/src/utils/compute-actions/buy-get.ts`, `packages/modules/promotion/src/utils/compute-actions/line-items.ts`, `packages/modules/promotion/src/utils/compute-actions/shipping-methods.ts`
- missed: `computeActions`, `promotion-module.ts` (path)
  - `computeActions` promotion-module.ts:697: (b) 1 reference(s) to computeActionForBudgetExceeded in computeActions (line 906) but none resolved, so no callers edge

## javascript: webpack (1 missed of 12)

### wp-usage-implicit-type-fallback (usage) — (b) unresolved references

- query: `implicitTypeLoaderFallback` · 781 tok
- kopt returned: `util/implicitTypeLoaderFallback.js:30-62 module.exports = (normalModuleFactory, pluginName, test, typ`; `types.d.ts:16537-16539 interface Loader`; `types.d.ts:16605-16610 LoaderItem`; `javascript/syntax.js:6531-6546 _tryModuleFallback()`; `container/FallbackModule.js:146-148 getSourceTypes()`
- callers line: `callers of #78m exports: none found`
- top candidate: `exports` (function, lib/util/implicitTypeLoaderFallback.js:30-62, query coverage 100%)
- expected: `CssModulesPlugin`, `HtmlModulesPlugin` in `lib/css/CssModulesPlugin.js`, `lib/html/HtmlModulesPlugin.js`
- missed: `CssModulesPlugin`, `HtmlModulesPlugin`, `CssModulesPlugin.js` (path), `HtmlModulesPlugin.js` (path)
  - `CssModulesPlugin` CssModulesPlugin.js:257: (b) 1 reference(s) to implicitTypeLoaderFallback in CssModulesPlugin (line 277) but none resolved, so no callers edge
  - `HtmlModulesPlugin` HtmlModulesPlugin.js:441: (b) 1 reference(s) to implicitTypeLoaderFallback in HtmlModulesPlugin (line 823) but none resolved, so no callers edge

## c_sharp: jellyfin (2 missed of 12)

### jf-locate-lockout (locate) — (e) needs multi-step exploration (also (d))

- query: `user disabled too many failed login attempts lockout event` · 1441 tok
- kopt returned: `Entities/User.cs:156-156 public int? LoginAttemptsBeforeLockout { get; set; }`; `Entities/User.cs:14-350 public class User : IHasPermissions, IHasConcurrencyToken`; `Entities/User.cs:141-141 User.InvalidLoginAttemptCount`; `Users/UserPolicy.cs:174-174 public int LoginAttemptsBeforeLockout { get; set; }`; `Users/UserPolicy.cs:14-198 Users.UserPolicy`
- callers line: `callers of #3ap Security.AuthenticationFailedLogger: none found`
- top candidate: `Jellyfin.Database.Implementations.Entities.User.LoginAttemptsBeforeLockout` (property, src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/User.cs:156-156, query coverage 44%)
- expected: `AuthenticateUser`, `UserLockedOutEventArgs` in `Jellyfin.Server.Implementations/Users/UserManager.cs`, `Jellyfin.Data/Events/Users/UserLockedOutEventArgs.cs`
- missed: `AuthenticateUser`, `UserLockedOutEventArgs`, `UserManager.cs` (path), `UserLockedOutEventArgs.cs` (path)
  - `AuthenticateUser` UserManager.cs:498: (e) query words cover 11% of it; reachable in one hop from shown #bvv User (it references the shown symbol)
  - `UserLockedOutEventArgs` UserLockedOutEventArgs.cs:8: (d) shown with a 4x budget (rank 19, after diversification 19)

### jf-explain-syncplay-wait (explain) — (d) budget / format

- query: `syncplay group waiting buffering members ready resume playback` · 1299 tok
- kopt returned: `PlaybackRequests/ReadyGroupRequest.cs:13-62 public class ReadyGroupRequest : AbstractPlaybackRequest`; `PlaybackRequests/BufferGroupRequest.cs:13-62 public class BufferGroupRequest : AbstractPlaybackRequest`; `SyncPlay/GroupMember.cs:11-59 public class GroupMember`; `SyncPlay/GroupMember.cs:58-58 public bool IgnoreGroupWait { get; set; }`; `GroupStates/WaitingGroupState.cs:41-41 public bool ResumePlaying { get; set; }`
- callers line: `callers of #bk3 PlaybackRequests.ReadyGroupRequest (+1 related decl) · 11 refs in 7 files · complete:`
- top candidate: `MediaBrowser.Controller.SyncPlay.PlaybackRequests.ReadyGroupRequest` (class, MediaBrowser.Controller/SyncPlay/PlaybackRequests/ReadyGroupRequest.cs:13-62, query coverage 50%)
- expected: `WaitingGroupState`, `HandleRequest`, `SetBuffering`, `IsBuffering` in `MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs`, `Emby.Server.Implementations/SyncPlay/Group.cs`
- missed: `SetBuffering`, `Group.cs` (path)
  - `SetBuffering` Group.cs:457: (d) shown with a 4x budget (rank 20, after diversification 16)
  - `IsBuffering` Group.cs:475: (d) shown with a 4x budget (rank 19, after diversification 15)

## go: gitea (1 missed of 12)

### gt-explain-egress (explain) — (e) needs multi-step exploration

- query: `outgoing http request host allow block list lax strict dns rebinding` · 956 tok
- kopt returned: `setting/security.go:47-55 func checkHostList(key, hostList string, isBlockList bool)`; `policy/matchlist.go:330-332 func NewBlockList(hostList string) *BlockList`; `policy/matchlist.go:326-328 func NewAllowList(hostList string, mode Mode) *AllowList`; `policy/matchlist.go:79-79 type BlockList struct`; `policy/matchlist.go:78-78 type AllowList struct`
- callers line: `callers of #9f8 setting.checkHostList · 3 refs in 3 files · complete:`
- top candidate: `setting.checkHostList` (function, modules/setting/security.go:47-55, query coverage 36%)
- expected: `checkAddr`, `gate`, `allowCheck`, `dialContext` in `modules/egress/policy/policy.go`
- missed: `checkAddr`, `dialContext`
  - `checkAddr` policy.go:109: (e) query words cover 9% of it; reachable in one hop from shown #5uq gate (it references the shown symbol)
  - `dialContext` policy.go:205: (e) query words cover 9% of it; reachable in one hop from shown #5ux NewDialContext (the shown symbol references it)

## kotlin: exposed (4 missed of 12)

### ex-locate-lifecycle-flush (locate) — (e) needs multi-step exploration

- query: `EntityLifecycleInterceptor flush entity cache before statement execution` · 1261 tok
- kopt returned: `dao/EntityLifecycleInterceptor.kt:28-143 class EntityLifecycleInterceptor : GlobalStatementIntercepto`; `dao/EntityLifecycleInterceptor.kt:34-37 @Suppress("ComplexMethod") override fun beforeExecution(tran`; `dao/EntityLifecycleInterceptor.kt:39-89 private fun beforeExecution(transaction: Transaction, contex`; `dao/EntityLifecycleInterceptor.kt:91-95 override fun afterExecution(transaction: Transaction, contex`; `dao/EntityLifecycleInterceptor.kt:97-102 override fun beforeCommit(transaction: Transaction)`
- callers line: `callers of #my EntityLifecycleInterceptor: none found`
- top candidate: `org.jetbrains.exposed.v1.dao.EntityLifecycleInterceptor` (class, exposed-dao/src/main/kotlin/org/jetbrains/exposed/v1/dao/EntityLifecycleInterceptor.kt:28-143, query coverage 56%)
- expected: `beforeExecution`, `flushEntities`, `flushCache` in `exposed-dao/src/main/kotlin/org/jetbrains/exposed/v1/dao/EntityLifecycleInterceptor.kt`, `exposed-dao/src/main/kotlin/org/jetbrains/exposed/v1/dao/EntityCache.kt`
- missed: `EntityCache.kt` (path)
  - `flushCache` EntityCache.kt:349: (e) query words cover 33% of it; reachable in one hop from shown #n1 beforeExecution (the shown symbol references it)

### ex-explain-entity-flush (explain) — (e) needs multi-step exploration

- query: `entity cache flush inserts updates foreign key order tables` · 1342 tok
- kopt returned: `dao/EntityCache.kt:349-355 fun Transaction.flushCache(): List<Entity<*>>`; `dao/EntityCache.kt:190-212 fun flush(tables: Iterable<IdTable<*>>)`; `dao/EntityCache.kt:152-160 fun flush()`; `dao/EntityCache.kt:236-282 @Suppress("TooGenericExceptionCaught") internal fun flushIns`; `dao/EntityCache.kt:22-341 EntityCache`
- callers line: `callers of #2t2 dao.flushCache · 44 refs in 13 files · complete:`
- top candidate: `org.jetbrains.exposed.v1.dao.flushCache` (function, exposed-dao/src/main/kotlin/org/jetbrains/exposed/v1/dao/EntityCache.kt:349-355, query coverage 56%)
- expected: `flush`, `flushInserts`, `updateEntities`, `sortTablesByReferences` in `exposed-dao/src/main/kotlin/org/jetbrains/exposed/v1/dao/EntityCache.kt`, `exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/SchemaUtils.kt`
- missed: `sortTablesByReferences`, `SchemaUtils.kt` (path)
  - `sortTablesByReferences` SchemaUtils.kt:18: (e) query words cover 33% of it; reachable in one hop from shown #2st flush (the shown symbol references it)

### ex-explain-nested-tx (explain) — (a) ranking / natural-language mismatch (also (d))

- query: `nested transactions useNestedTransactions outer transaction savepoint rollback` · 1622 tok
- kopt returned: `core/DatabaseConfig.kt:16-16 val useNestedTransactions: Boolean`; `core/DatabaseConfig.kt:212-212 override val useNestedTransactions: Boolean`; `core/DatabaseApi.kt:18-18 val useNestedTransactions: Boolean = config.useNestedTransac`; `transaction/SpringTransactionManager.kt:56-56 override fun useSavepointForNestedTransaction()`; `transaction/SpringTransactionManager.kt:55-55 override fun useSavepointForNestedTransaction()`
- top candidate: `org.jetbrains.exposed.v1.core.DatabaseConfig.useNestedTransactions` (property, exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/DatabaseConfig.kt:16-16, query coverage 57%)
- expected: `newTransaction`, `ThreadLocalTransaction`, `rollback`, `savepointName` in `exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/transactions/TransactionManager.kt`
- missed: `ThreadLocalTransaction`, `savepointName`
  - `ThreadLocalTransaction` TransactionManager.kt:202: (d) shown with a 4x budget (rank 18, after diversification 17)
  - `savepointName` TransactionManager.kt:284: (a) ranked 128 of 400 candidates (pack lists 12 pointers; below the weak-tail cut: score 26% of the top); query words cover 43% of it; top candidate org.jetbrains.exposed.v1.core.DatabaseConfig.useNestedTransactions covers 57%

### ex-explain-table-order (explain) — (e) needs multi-step exploration (also (d))

- query: `tables order foreign key references create cycle detection graph` · 1373 tok
- kopt returned: `core/Table.kt:1769-1781 fun foreignKey( vararg from: Column<*>, target: PrimaryKey, `; `core/Table.kt:1796-1803 fun foreignKey( vararg references: Pair<Column<*>, Column<*>`; `core/Table.kt:1390-1401 fun <T : Any> reference( name: String, foreign: IdTable<T>, `; `core/Table.kt:1275-1288 fun <T : Any, S : T, C : Column<S>> C.references( ref: Colum`; `core/Table.kt:1303-1317 @JvmName("referencesById") fun <T : Any, S : T, C : Column<S`
- callers line: `callers of #c4 Table.foreignKey (+1 related decl) · 16 refs in 12 files · 10 unresolved same-name refs:`
- top candidate: `org.jetbrains.exposed.v1.core.Table.foreignKey` (method, exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Table.kt:1769-1781, query coverage 56%)
- expected: `TableDepthGraph`, `sorted`, `hasCycle` in `exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/TableDepthGraph.kt`
- missed: `sorted`, `TableDepthGraph.kt` (path)
  - `TableDepthGraph` TableDepthGraph.kt:3: (d) shown with a 4x budget (rank 18, after diversification 16)
  - `sorted` TableDepthGraph.kt:25: (e) query words cover 22% of it; reachable in one hop from shown #8y Table (it references the shown symbol)
  - `hasCycle` TableDepthGraph.kt:44: (d) shown with a 4x budget (rank 21, after diversification 19)

## rust: meilisearch (5 missed of 12)

### ms-explain-dynamic-rules (explain) — (d) budget / format

- query: `dynamic search rules pin documents time query filter conditions` · 1391 tok
- kopt returned: `src/dynamic_search_rules.rs:7-9 pub struct DynamicSearchRules<'a>`; `dynamic_search_rules/mod.rs:55-59 pub struct DynamicSearchRules`; `src/lib.rs:1255-1263 pub fn dynamic_search_rules( &self, features: RoFeatures, di`; `src/lib.rs:25-25 mod dynamic_search_rules`; `src/lib.rs:113-113 db_name.DYNAMIC_SEARCH_RULES`
- callers line: `callers of #7cb IndexScheduler.dynamic_search_rules · 1 ref in 1 file · 6 unresolved same-name refs:`
- top candidate: `DynamicSearchRules` (struct, crates/index-scheduler/src/dynamic_search_rules.rs:7-9, query coverage 33%)
- expected: `resolve_actions`, `active_rules_for_query`, `apply_time_conditions`, `find_actions` in `crates/milli/src/dynamic_search_rules/mod.rs`, `crates/milli/src/dynamic_search_rules/condition.rs`, `crates/milli/src/dynamic_search_rules/action.rs`
- missed: `active_rules_for_query`, `apply_time_conditions`, `find_actions`, `condition.rs` (path), `action.rs` (path)
  - `active_rules_for_query` condition.rs:18: (d) shown with a 4x budget (rank 21, after diversification 21)
  - `apply_time_conditions` condition.rs:34: (d) shown with a 4x budget (rank 28, after diversification 23)
  - `find_actions` action.rs:49: (d) shown with a 4x budget (rank 124, after diversification none)

### ms-explain-bucket-sort (explain) — (d) budget / format

- query: `ranking rules buckets candidates sort results` · 1334 tok
- kopt returned: `logger/mod.rs:44-50 fn skip_bucket_ranking_rule( &mut self, _ranking_rule_idx: u`; `logger/mod.rs:35-42 fn next_bucket_ranking_rule( &mut self, _ranking_rule_idx: u`; `new/bucket_sort.rs:315-393 fn maybe_add_to_results<'ctx, Q: RankingRuleQueryTrait>( ctx`; `new/bucket_sort.rs:23-310 pub fn bucket_sort<'ctx, Q: RankingRuleQueryTrait>( ctx: &mu`; `new/sort.rs:198-222 fn next_bucket( &mut self, _ctx: &mut SearchContext<'ctx>, _`
- callers line: `callers of #5s6 SearchLogger.skip_bucket_ranking_rule: none resolved; possible (unresolved refs named skip_bucket_ranking_rule):`
- top candidate: `SearchLogger.skip_bucket_ranking_rule` (method, crates/milli/src/search/new/logger/mod.rs:44-50, query coverage 67%)
- expected: `bucket_sort`, `maybe_add_to_results`, `RankingRule`, `next_bucket` in `crates/milli/src/search/new/bucket_sort.rs`, `crates/milli/src/search/new/ranking_rules.rs`
- missed: `ranking_rules.rs` (path)
  - `RankingRule` ranking_rules.rs:26: (d) shown with a 4x budget (rank 27, after diversification 25)
  - `next_bucket` ranking_rules.rs:53: (d) shown with a 4x budget (rank 14, after diversification 13)

### ms-usage-is-exact (usage) — (b) unresolved references

- query: `DisabledTyposTerms is_exact` · 947 tok
- kopt returned: `src/disabled_typos_terms.rs:38-41 pub fn is_exact(&self, word: &str) -> bool`; `src/disabled_typos_terms.rs:10-12 pub struct DisabledTyposTerms`; `src/disabled_typos_terms.rs:15-20 pub fn disabled_typos_terms(&self, txn: &RoTxn<'_>) -> heed:`; `src/disabled_typos_terms.rs:22-34 pub(crate) fn put_disabled_typos_terms( &self, txn: &mut RwT`; `src/index_uid_pattern.rs:35-37 pub fn is_exact(&self) -> bool`
- callers line: `callers of #8ai DisabledTyposTerms.is_exact · 2 refs in 1 file · 7 unresolved same-name refs:`
- top candidate: `DisabledTyposTerms.is_exact` (method, crates/milli/src/disabled_typos_terms.rs:38-41, query coverage 100%)
- expected: `extract_word_docids`, `extract_document_change`, `extract_document_from_settings_change`, `extract_numbers_from_words_fst` in `crates/milli/src/update/index_documents/extract/extract_word_docids.rs`, `crates/milli/src/update/new/extract/searchable/extract_word_docids.rs`, `crates/milli/src/update/new/indexer/mod.rs`
- missed: `extract_word_docids`, `extract_document_change`, `extract_document_from_settings_change`, `extract_word_docids.rs` (path), `extract_word_docids.rs` (path)
  - `extract_word_docids` extract_word_docids.rs:28: (b) 2 reference(s) to is_exact/DisabledTyposTerms in extract_word_docids (line 130, 143) but none resolved, so no callers edge
  - `extract_document_change` extract_word_docids.rs:333: (b) 2 reference(s) to is_exact/DisabledTyposTerms in extract_document_change (line 349, 351, 378, 407, 424, 442) but none resolved, so no callers edge
  - `extract_document_from_settings_change` extract_word_docids.rs:570: (b) 2 reference(s) to is_exact/DisabledTyposTerms in extract_document_from_settings_change (line 730, 746, 762, 772, 801, 825) but none resolved, so no callers edge

### ms-usage-facet-bounds (usage) — (c) extraction gap

- query: `find_docids_of_facet_within_bounds` · 1260 tok
- kopt returned: `facet/facet_range_search.rs:15-67 pub fn find_docids_of_facet_within_bounds<'t, BoundCodec>( r`; `facet/mod.rs:455-463 pub fn delete_single_docid<'a>( &self, wtxn: &'a mut RwTxn<'`; `new/channel.rs:566-568 pub fn facet_docids<'a>(&'a self) -> FacetDocidsSender<'a, '`
- callers line: `callers of #8iz find_docids_of_facet_within_bounds · 6 refs in 3 files · complete:`
- top candidate: `find_docids_of_facet_within_bounds` (function, crates/milli/src/search/facet/facet_range_search.rs:15-67, query coverage 100%)
- expected: `apply_time_conditions`, `apply_filter_conditions`, `resolve_constraints`, `evaluate_operator`, `explore_facet_levels` in `crates/milli/src/dynamic_search_rules/condition.rs`, `crates/milli/src/search/facet/filter/index_filter.rs`
- missed: `evaluate_operator`, `explore_facet_levels`
  - `evaluate_operator` index_filter.rs:109: (c) the use of find_docids_of_facet_within_bounds at line 273 is not extracted as a reference
  - `explore_facet_levels` index_filter.rs:332: (c) the use of find_docids_of_facet_within_bounds at line 353 is not extracted as a reference

### ms-impact-search-rules (impact) — (b) unresolved references

- query: `AuthFilter get_index_search_rules tenant token filter search routes` · 1287 tok
- kopt returned: `src/lib.rs:291-297 pub fn get_index_search_rules(&self, index: &str) -> Option<`; `src/lib.rs:198-202 pub struct AuthFilter`; `src/lib.rs:330-347 fn get_index_search_rules(&self, index: &str) -> Option<Inde`; `src/lib.rs:259-264 pub fn tenant_token_is_index_authorized(&self, index: &str) `; `src/lib.rs:267-279 pub fn tenant_token_list_index_authorized(&self) -> Vec<Stri`
- callers line: `callers of #as5 AuthFilter.get_index_search_rules · 1 ref in 1 file · 7 unresolved same-name refs:`
- top candidate: `AuthFilter.get_index_search_rules` (method, crates/meilisearch-auth/src/lib.rs:291-297, query coverage 70%)
- expected: `get_index_search_rules`, `legacy_search_with_url_query`, `legacy_search_with_post`, `search`, `similar` in `crates/meilisearch-auth/src/lib.rs`, `crates/meilisearch/src/routes/indexes/search.rs`, `crates/meilisearch/src/routes/indexes/facet_search.rs`, `crates/meilisearch/src/routes/indexes/similar.rs`
- missed: `legacy_search_with_url_query`, `legacy_search_with_post`, `search`, `similar`, `search.rs` (path), `facet_search.rs` (path), `similar.rs` (path)
  - `legacy_search_with_url_query` search.rs:631: (b) 1 reference(s) to get_index_search_rules/AuthFilter in legacy_search_with_url_query (line 650) but none resolved, so no callers edge
  - `legacy_search_with_post` search.rs:962: (b) 1 reference(s) to get_index_search_rules/AuthFilter in legacy_search_with_post (line 982) but none resolved, so no callers edge
  - `search` facet_search.rs:302: (b) 1 reference(s) to get_index_search_rules/AuthFilter in search (line 324) but none resolved, so no callers edge
  - `similar` similar.rs:204: (b) 1 reference(s) to get_index_search_rules/AuthFilter in similar (line 213) but none resolved, so no callers edge

## php: laravel (3 missed of 12)

### lv-locate-cache-flexible (locate) — (e) needs multi-step exploration

- query: `cache stale value refresh background after response lock` · 1314 tok
- kopt returned: `Cache/LuaScripts.php:32-47 public static function refreshLock()`; `Cache/Repository.php:652-692 public function flexible($key, $ttl, $callback, $lock = null`; `Cache/DatabaseLock.php:110-119 public function refresh($seconds = null)`; `Cache/MemcachedLock.php:47-58 public function refresh($seconds = null)`; `Cache/Lock.php:147-150 public function refresh($seconds = null)`
- callers line: `callers of #247 LuaScripts.refreshLock · 2 refs in 2 files · complete:`
- top candidate: `Illuminate.Cache.LuaScripts.refreshLock` (method, src/Illuminate/Cache/LuaScripts.php:32-47, query coverage 38%)
- expected: `flexible`, `defer` in `src/Illuminate/Cache/Repository.php`, `src/Illuminate/Support/functions.php`
- missed: `functions.php` (path)
  - `defer` functions.php:21: (e) query words cover 0% of it; reachable in one hop from shown #59x flexible (the shown symbol references it)

### lv-explain-http-batch (explain) — (d) budget / format

- query: `http client batch concurrent requests concurrency progress catch then finally` · 838 tok
- kopt returned: `Client/Batch.php:243-248 public function concurrency(int $limit): self`; `Client/Batch.php:191-196 public function progress(Closure $callback): self`; `Client/Batch.php:18-451 class Batch`; `Client/Batch.php:230-235 public function finally(Closure $callback): self`; `Client/Batch.php:217-222 public function then(Closure $callback): self`
- callers line: `callers of #9nn Batch.concurrency · 1 ref in 1 file · complete:`
- top candidate: `Illuminate.Http.Client.Batch.concurrency` (method, src/Illuminate/Http/Client/Batch.php:243-248, query coverage 60%)
- expected: `send`, `concurrency`, `hasFailures`, `incrementFailedRequests` in `src/Illuminate/Http/Client/Batch.php`
- missed: `hasFailures`
  - `hasFailures` Batch.php:413: (d) shown with a 4x budget (rank 91, after diversification 61)

### lv-explain-concurrency (explain) — (d) budget / format

- query: `concurrency run closures parallel child processes results` · 1434 tok
- kopt returned: `Concurrency/ProcessDriver.php:34-77 public function run(Closure\|array $tasks, CarbonInterval\|int`; `Concurrency/ProcessDriver.php:19-98 Concurrency.ProcessDriver`; `Concurrency/ForkDriver.php:19-32 public function run(Closure\|array $tasks, CarbonInterval\|int`; `Concurrency/Driver.php:14-14 public function run(Closure\|array $tasks, CarbonInterval\|int`; `Concurrency/SyncDriver.php:18-23 public function run(Closure\|array $tasks, CarbonInterval\|int`
- callers line: `callers of #7rj ProcessDriver.run (+1 related decl) · 3 refs in 3 files · 93 unresolved same-name refs:`
- top candidate: `Illuminate.Concurrency.ProcessDriver.run` (method, src/Illuminate/Concurrency/ProcessDriver.php:34-77, query coverage 71%)
- expected: `run`, `defer`, `InvokeSerializedClosureCommand`, `handle` in `src/Illuminate/Concurrency/ProcessDriver.php`, `src/Illuminate/Concurrency/Console/InvokeSerializedClosureCommand.php`
- missed: `InvokeSerializedClosureCommand`, `handle`, `InvokeSerializedClosureCommand.php` (path)
  - `InvokeSerializedClosureCommand` InvokeSerializedClosureCommand.php:11: (d) shown with a 4x budget (rank 25, after diversification 24)
  - `handle` InvokeSerializedClosureCommand.php:41: (d) shown with a 4x budget (rank 87, after diversification 74)

## ruby: discourse (1 missed of 12)

### ds-explain-upcoming-promotion (explain) — (a) ranking / natural-language mismatch

- query: `upcoming change automatic promotion status notify admins once` · 1325 tok
- kopt returned: `upcoming_changes/notify_promotion.rb:24-166 class UpcomingChanges::NotifyPromotion`; `upcoming_changes/notify_promotion.rb:109-111 def notify_admins?(params:)`; `upcoming_changes/notify_promotion.rb:136-146 def notify_admins(params:, bulk_notification_new_records:, e`; `upcoming_changes/notify_promotion.rb:89-91 def should_notify_admins(params:)`; `upcoming_changes/notify_promotion.rb:156-161 NotifyPromotion.create_automatically_promoted_event`
- callers line: `callers of #aqk NotifyPromotion: none found`
- top candidate: `NotifyPromotion` (class, app/services/upcoming_changes/notify_promotion.rb:24-166, query coverage 75%)
- expected: `NotifyPromotion`, `promotion_not_already_handled`, `admin_has_not_manually_toggled`, `notify_admins?`, `meets_or_exceeds_status?` in `app/services/upcoming_changes/notify_promotion.rb`, `lib/upcoming_changes.rb`
- missed: `meets_or_exceeds_status?`, `upcoming_changes.rb` (path)
  - `meets_or_exceeds_status?` upcoming_changes.rb:164: (a) ranked 87 of 541 candidates (pack lists 12 pointers; dropped by the per-file cap: 3 hits of this file already listed); query words cover 38% of it; top candidate NotifyPromotion covers 75%

## scala: playframework (4 missed of 12)

### pf-locate-jwt-session (locate) — (a) ranking / natural-language mismatch

- query: `session cookie jwt expired clock skew signature algorithm legacy signed cookie` · 1305 tok
- kopt returned: `http/HttpConfiguration.scala:371-376 case class JWTConfiguration( signatureAlgorithm: String = "H`; `http/HttpConfiguration.scala:392-411 private def getSignatureAlgorithm( config: Configuration, se`; `http/HttpConfiguration.scala:106-115 SessionConfiguration`; `mvc/Session.scala:138-142 class LegacySessionCookieBaker @Inject() (val config: Sessio`; `mvc/Session.scala:120-130 class DefaultSessionCookieBaker @Inject() ( val config: Sess`
- callers line: `callers of #60f JWTConfiguration · 10 refs in 3 files · complete:`
- top candidate: `play.api.http.JWTConfiguration` (class, core/play/src/main/scala/play/api/http/HttpConfiguration.scala:371-376, query coverage 70%)
- expected: `JWTCookieDataCodec`, `JWTFormatter`, `parse`, `FallbackCookieDataCodec` in `core/play/src/main/scala/play/api/mvc/Cookie.scala`
- missed: `parse`
  - `parse` Cookie.scala:752: (a) ranked 85 of 401 candidates (pack lists 12 pointers; 73 after diversification); query words cover 20% of it; top candidate play.api.http.JWTConfiguration covers 70%

### pf-explain-gzip (explain) — (e) needs multi-step exploration

- query: `gzip filter compress response threshold chunked accept encoding` · 1364 tok
- kopt returned: `gzip/GzipFilter.scala:203-225 case class GzipFilterConfig( bufferSize: Int = 8192, chunked`; `gzip/GzipFilter.scala:218-218 def withChunkedThreshold(threshold: Int): GzipFilterConfig`; `gzip/GzipFilter.scala:54-61 def this( bufferSize: Int = 8192, chunkedThreshold: Int = 10`; `gzip/GzipFilter.scala:50-191 @Singleton class GzipFilter @Inject() (config: GzipFilterCon`; `gzip/GzipFilter.scala:170-179 private def shouldCompress(result: Result)`
- callers line: `callers of #d2h GzipFilterConfig · 9 refs in 3 files · complete:`
- top candidate: `play.filters.gzip.GzipFilterConfig` (class, web/play-filters-helpers/src/main/scala/play/filters/gzip/GzipFilter.scala:203-225, query coverage 63%)
- expected: `handleResult`, `shouldCompress`, `mayCompress`, `gzipIsAcceptedAndPreferredBy` in `web/play-filters-helpers/src/main/scala/play/filters/gzip/GzipFilter.scala`
- missed: `handleResult`
  - `handleResult` GzipFilter.scala:77: (e) query words cover 25% of it; reachable in one hop from shown #d2d shouldCompress (it references the shown symbol)

### pf-explain-cached (explain) — (a) ranking / natural-language mismatch

- query: `Cached action result cache etag expires not modified` · 1373 tok
- kopt returned: `controllers/Assets.scala:738-761 private def maybeNotModified( request: RequestHeader, assetI`; `controllers/Assets.scala:763-772 private def cacheableResult[A <: Result](assetInfo: AssetInf`; `cache/CachedAction.java:14-28 public class CachedAction extends Action<Cached>`; `cache/Cached.java:15-32 @With(CachedAction.class) @Target({ElementType.TYPE, Element`; `cache/Cached.scala:26-118 class Cached @Inject() (cache: AsyncCacheApi)(implicit mater`
- callers line: `callers of #rn AssetsBuilder.maybeNotModified · 1 ref in 1 file · complete:`
- top candidate: `controllers.AssetsBuilder.maybeNotModified` (method, core/play/src/main/scala/play/api/controllers/Assets.scala:738-761, query coverage 50%)
- expected: `CachedBuilder`, `build`, `handleResult`, `cachingWithEternity` in `cache/play-cache/src/main/scala/play/api/cache/Cached.scala`
- missed: `cachingWithEternity`
  - `cachingWithEternity` Cached.scala:199: (a) ranked 251 of 445 candidates (pack lists 12 pointers; 146 after diversification); query words cover 25% of it; top candidate controllers.AssetsBuilder.maybeNotModified covers 50%

### pf-usage-assets-digest (usage) — (c) extraction gap (also (b))

- query: `assets controller digest fingerprint` · 1299 tok
- kopt returned: `controllers/Assets.scala:333-333 private[controllers] def digest(path: String): Option[String`; `controllers/Assets.scala:322-323 private[controllers] override def digest(path: String)`; `controllers/Assets.scala:513-599 private class AssetInfo( val name: String, val url: URL, val`; `controllers/Assets.scala:687-687 case class Asset(name: String)`; `controllers/Assets.scala:634-716 object Assets`
- callers line: `callers of #q7 AssetsMetadata.digest (+2 related decls) · 2 refs in 1 file · 7 unresolved same-name refs:`
- top candidate: `controllers.AssetsMetadata.digest` (method, core/play/src/main/scala/play/api/controllers/Assets.scala:333-333, query coverage 75%)
- expected: `findAssetPath`, `assetInfoFromResource`, `versioned`, `StaticAssetsMetadata` in `core/play/src/main/scala/play/api/controllers/Assets.scala`
- missed: `findAssetPath`, `versioned`
  - `findAssetPath` Assets.scala:424: (c) `findAssetPath` is indexed in this file but no range covers line 424 (method 362-362)
  - `versioned` Assets.scala:794: (b) 1 reference(s) to digest in versioned (line 802) but none resolved, so no callers edge

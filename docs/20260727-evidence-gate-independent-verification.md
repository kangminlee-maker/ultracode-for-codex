# 증거 게이트: 독립 검증과 세 가지 추가 발견

- 대상: `ultracode-for-codex` 0.6.1 (설치본 `/opt/homebrew/lib/node_modules/ultracode-for-codex`, 소스 `main` @ `218a1b9`)
- 확인일: 2026-07-27
- 확인 방법: 설치본 `dist` 독해 + 런타임 8케이스 실행(대조군 포함, 토큰 0) + 이 머신에 남은 실패 잡 기록 전수 조회 + `git log`
- 이 문서의 독자: `docs/20260727-code-review-evidence-gate-manual.md`를 읽은 사람, 그리고 게이트를 손볼 사람
- 관계: 위 매뉴얼을 **독립적으로 재현해 확인**하고, 매뉴얼에 없는 세 가지를 덧붙입니다. 매뉴얼의 판정을 뒤집는 내용은 없습니다.

---

## Part 1. 매뉴얼 주장의 독립 재현

매뉴얼을 읽지 않은 상태에서 만든 서술을 매뉴얼이 반박했고, 그래서 매뉴얼 쪽을 다시 검증했습니다. 소스가 아니라 **설치된 `dist`** 기준입니다.

| 매뉴얼 주장 | 재현 결과 | 근거 |
| --- | --- | --- |
| git repo 검사는 없다 | **확인** | `dist`에 `requires a git repository` 문자열은 1개뿐이고 worktree 격리용 |
| 게이트는 `allowedFileRefs.length === 0` | **확인** | 문자열 존재, `workflow-runtime.js` |
| 허용 확장자 18개 | **확인** | `WORKSPACE_CONTEXT_ALLOWED_EXTENSIONS`, dist 기준 정확히 18개 |
| 제외 디렉터리 10개 | **확인** | `WORKSPACE_CONTEXT_EXCLUDED_DIRS` |
| 게이트는 `code-review` 안에만 있다 | **확인** | 빌트인은 `task`/`code-review`/`batch`, 게이트는 code-review 스크립트 본문 |

런타임 프로브(FakeSubagent가 첫 호출에서 예외 → 백엔드 호출 수로 스폰 이전 차단을 확인):

| 케이스 | gate blocked | agent spawned | backend calls |
| --- | --- | --- | --- |
| 비-git 디렉터리 | true | false | 0 |
| 깨끗한 트리 | true | false | 0 |
| **`.ts` 변경 (대조군)** | **false** | **true** | **1** |
| `.java`만 변경 | true | false | 0 |
| `Dockerfile`+`Makefile`만 | true | false | 0 |
| `dist/` 밑만 변경 | true | false | 0 |
| **`.java` + `notes.md` (대조군)** | **false** | **true** | **1** |
| 깨끗한 트리 + `diffBaseRef` | true | false | 0 |

대조군 2개가 통과하므로 "게이트가 무엇이든 막는다"는 아닙니다. 재현 스크립트는 부록 A.

---

## Part 2. 발견 1 — 경로 필터가 둘이고, 서로 다릅니다

매뉴얼은 허용목록 밖 파일이 "리뷰에 아예 보이지 않는다"고 적었습니다. 실제로는 **이름은 보이고 내용과 인용만 막힙니다.** 필터가 두 개이기 때문입니다.

| 함수 | 결정하는 것 | 제외 디렉터리 | 확장자 검사 |
| --- | --- | --- | --- |
| `shouldExposeWorkspaceStatusPath` (`:4038`) | 프롬프트의 git status 목록 | 함 | **안 함** |
| `shouldIncludeWorkspaceContextPath` (`:4021`) | 파일 내용 + `allowedEvidenceRefs` | 함 | **함** |

`src/App.java`·`notes.md`·`Dockerfile`·`dist/bundle.js` 네 개를 수정한 트리에서 에이전트가 실제로 받은 프롬프트:

```
?? Dockerfile
?? notes.md
?? src/App.java
?? <excluded path omitted>

### Allowed Evidence Refs
file:notes.md

### Included Files
--- notes.md (8 bytes) ---
--- README.md (8 bytes) ---
```

리뷰어는 `src/App.java`와 `Dockerfile`이 **바뀌었다는 사실을 통보받고**, 그 내용은 받지 못하며, 언급하면 런이 중단됩니다. 모델 입장에서 이 조합은 자연스럽게 함정이 됩니다 — 바뀐 것을 알려줬으니 들여다보려 합니다.

의도된 설계일 수 있습니다(status 전체를 보여주는 것이 상황 파악에 유리하므로). 다만 그렇다면 **인용 불가라는 사실이 목록에 표시되어야** 모델이 헛짚지 않습니다.

---

## Part 3. 발견 2 — 관측된 거부는 범위 오류가 아니라 **문법 오류**였습니다

`unsupported evidence ref`로 죽은 런을 "허용목록 밖 파일을 인용해서"로 설명하기 쉽지만, 이 머신에 남은 기록에서는 **한 건도 그렇지 않았습니다.**

디스크 전체(`~/.ultracode-for-codex`, 두 프로젝트 로컬 스토어)에서 `unsupported evidence ref` 메시지를 전수 조회한 결과 고유 거부 ref는 **2종**입니다. 둘 다 허용 확장자이고, 둘 다 **같은 런의 허용목록에 그 파일이 이미 있었습니다.**

**케이스 1** — 거부: `file:development-records/design/20260710-s4-4-fallback-provider-swap-design.md:74`

같은 런의 허용목록:
```
file:development-records/design/20260710-s4-4-fallback-provider-swap-design.md
diff:unstaged:development-records/design/20260710-s4-4-fallback-provider-swap-design.md
hunk:unstaged:development-records/design/20260710-s4-4-fallback-provider-swap-design.md:1
hunk:unstaged:development-records/design/20260710-s4-4-fallback-provider-swap-design.md:2
```

모델이 `file:` ref에 **`:74`를 붙였습니다.** 코드를 인용할 때 `파일:줄`은 사람이 쓰는 표준 형식이라 자연스러운 실수입니다. 그리고 이 실수가 두 번 어긋납니다 — 숫자를 붙일 수 있는 것은 `hunk:` 뿐이고, 거기서의 숫자는 **줄번호가 아니라 파일별 1-based 헝크 인덱스**입니다(`workflow-runtime.ts:4324`, `hunk:${kind}:${currentPath}:${hunkIndex}`). 즉 `:74`는 형식도 틀렸고 의미도 다릅니다.

**케이스 2** — 거부: `diff:unstaged:src/services/department-analytics.service.ts`

같은 런의 허용목록에 이 파일로 존재한 ref:
```
file:src/services/department-analytics.service.ts
```

파일은 있었지만 `diff:unstaged:` 종류로는 만들어지지 않았습니다. 같은 파일이라도 `file:` / `diff:<kind>:` / `hunk:<kind>:<n>` 중 **실제로 생성된 것만** 유효한데, 어떤 종류가 생성되는지는 그 파일이 미추적인지 unstaged인지 staged인지에 달려 있습니다. 모델이 알 수 없는 정보로 종류를 골라야 하는 셈입니다.

### 함의

거부의 원인이 "무엇을 볼 수 있었나"가 아니라 **"어떤 문자열을 써야 하나"** 라면, 이 실패는 리뷰 품질 문제가 아니라 인터페이스 문제입니다. 그리고 대가가 큽니다 — 페일클로즈가 런 전체를 중단시키므로, 마지막 단계에서 문자열 하나가 어긋나면 그때까지의 에이전트 결과가 전부 버려집니다.

---

## Part 4. 발견 3 — 허용목록의 출처 (추정, 근거 제시)

확장자 18개가 "무엇을 리뷰해도 되는가"의 기준으로 보이지만, **원래 그 용도로 만들어지지 않았을 가능성이 높습니다.**

| 근거 | 내용 |
| --- | --- |
| 연대 | 상수 3종은 `56d3c73` (2026-06-22, 최초 릴리스). 리뷰 워크플로는 `bebe3d6` (06-23), 게이트 강화는 `c6b341f` (07-06). **필터가 리뷰보다 먼저** |
| 이름 | `REVIEW_SCOPE_*`가 아니라 `WORKSPACE_CONTEXT_*` |
| 원래 용도 | 같은 상수를 쓰는 `walkWorkspaceContextFiles`는 **500개에서 잘라내는** 디렉터리 순회 — 프롬프트 예산 관리 |
| 우선 파일 목록 | 8개 중 6개(`IMPLEMENTATION_MAP.html`, `README.md`, `ULTRACODE_INSTALL.md`, `package.json`, `tsconfig.json`, `SKILL.md`)가 **최초 커밋이 스스로 만든 파일** |
| 확장자 구성 | JS/TS 생태계 + Python/Go/Rust/셸 + 문서·설정 포맷. `.java`·`.rb`·`.cs`가 덜 텍스트여서 빠진 것이 아님 |
| 이후 변경 | 최초 도입 이후 목록을 손댄 커밋 없음 |

정리하면 **"프롬프트에 넣을 가치가 있는 파일"을 고르던 예산 휴리스틱이, 리뷰 워크플로가 닫힌 인용 집합을 필요로 하면서 그대로 "인용해도 되는 파일" 정책으로 승격**된 것으로 보입니다. 두 목적은 다릅니다 — 예산 필터는 빠뜨려도 프롬프트가 조금 얇아질 뿐이지만, 범위 정책은 빠뜨리면 그 언어의 프로젝트를 리뷰할 수 없게 만듭니다.

이 부분은 코드에 주석이 없어 **추정**입니다. 위 여섯 가지가 같은 방향을 가리킨다는 것이 근거의 전부입니다.

---

## Part 5. 제안

권한 밖의 제안이므로 판단은 메인테이너 몫입니다. 비용이 낮은 순서입니다.

**(1) ref 문법 관용 — 가장 값싼 개선**

`file:<path>:<n>` 형태를 `file:<path>`로 정규화해서 대조하거나, 종류가 틀렸어도 **경로가 허용 경로 집합에 있으면** 통과시키는 방안. 관측된 거부 2종이 모두 이 한 줄로 살아납니다. 페일클로즈의 목적(허용되지 않은 **파일**을 인용하는 환각 차단)은 경로 단위 대조로도 그대로 달성됩니다.

**(2) 프롬프트가 문법을 명시**

허용목록을 나열하는 것만으로는 모델이 "이 파일은 `file:`로만 인용 가능하고 `diff:unstaged:`는 존재하지 않는다"를 알 수 없습니다. 목록 자체가 그 정보를 담고 있으므로, "이 목록의 문자열을 **그대로** 쓸 것, 줄번호를 덧붙이지 말 것"을 한 줄 덧붙이는 것으로 충분해 보입니다.

**(3) 두 필터의 비대칭 표시**

status 목록에 인용 불가 경로를 표시하거나(`?? src/App.java (not citable)`), 같은 필터로 좁히거나. 현재는 모델에게 보여주고 벌하는 모양입니다.

**(4) 확장자 목록의 위상 정리**

설정 가능하게 하거나, 최소한 "이것이 리뷰 범위를 결정한다"는 사실을 README/실패 메시지에 명시. 현재 실패 메시지는 `no reviewable change evidence in the working tree`까지만 말하고 확장자를 언급하지 않아, `.java`만 바꾼 사용자는 원인을 찾기 어렵습니다.

---

## 부록 A. 재현 스크립트

설치본을 직접 import하므로 빌드가 필요 없고, 가짜 백엔드가 첫 호출에서 예외를 던지므로 토큰 비용이 0입니다.

```js
// probe.mjs — node probe.mjs
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WorkflowTaskRegistry } from '/opt/homebrew/lib/node_modules/ultracode-for-codex/dist/runtime/workflow-runtime.js';

const x = promisify(execFile);

async function probe(label, files, { git = true, args = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'probe-'));
  if (git) {
    const g = (...a) => x('git', a, { cwd: root });
    await g('init'); await g('config', 'user.email', 'p@e.invalid'); await g('config', 'user.name', 'P');
    await writeFile(join(root, 'README.md'), '# probe\n');
    await g('add', '.'); await g('commit', '-m', 'init');
  }
  for (const f of files) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), 'changed\n');
  }
  const backend = { name: 'p', model: 'p', calls: 0,
    async generate() { this.calls += 1; throw new Error('STOP'); }, async close() {} };
  const runtime = new WorkflowTaskRegistry({ backend, cwd: root,
    stateDir: join(root, '.ultracode-for-codex'), requestTimeoutMs: 20000 });
  const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review.', ...args } });
  const events = [];
  for await (const e of runtime.streamEvents(launch.taskId)) events.push(e);
  const s = runtime.get(launch.taskId);
  console.log(String(label).padEnd(30),
    '| gate blocked:', String(/no reviewable change evidence/.test(s.error ?? '')).padEnd(5),
    '| agent spawned:', String(events.some((e) => e.type === 'workflow.agent.started')).padEnd(5),
    '| backend calls:', backend.calls);
  await runtime.close(); await rm(root, { recursive: true, force: true });
}

await probe('non-git', ['src/app.ts'], { git: false });
await probe('clean tree', []);
await probe('.ts change (control)', ['src/app.ts']);
await probe('.java only', ['src/App.java']);
await probe('Dockerfile+Makefile', ['Dockerfile', 'Makefile']);
await probe('dist/ only', ['dist/bundle.js']);
await probe('.java + notes.md (control)', ['src/App.java', 'notes.md']);
await probe('clean + diffBaseRef', [], { args: { diffBaseRef: 'HEAD' } });
```

허용목록을 직접 보려면 `backend.generate`에서 첫 요청을 문자열로 덤프한 뒤 `Allowed Evidence Refs` 이후를 출력하면 됩니다.

---

## 부록 B. 이 문서의 한계

- **거부 사례가 2종뿐입니다.** 이 머신에 남은 기록 전수이고, 그 이상은 이미 정리되었거나 다른 머신에 있습니다. "관측된 거부는 전부 문법 오류"는 **N=2에 대한 진술**이며, 실패 잡 전체의 원인 분포를 대표한다고 주장하지 않습니다. Part 3의 함의는 그만큼 할인해서 읽어야 합니다.
- **성공 런을 끝까지 돌리지 않았습니다.** 모든 프로브는 첫 백엔드 호출에서 중단되므로, 게이트 이후 단계의 동작은 검증 범위 밖입니다.
- **Part 4는 추정입니다.** 상수 정의부에 주석이 없어 저자 의도를 직접 확인할 수 없었고, 여섯 가지 정황이 같은 방향을 가리킨다는 것이 근거의 전부입니다. 저자가 처음부터 리뷰 범위로 의도했다면 Part 4는 틀린 이야기이고, 그 경우 남는 것은 Part 5(4)의 "명시해 달라"는 요청뿐입니다.
- **품질·재현율은 다루지 않았습니다.** 이 문서는 게이트의 동작만 봅니다.

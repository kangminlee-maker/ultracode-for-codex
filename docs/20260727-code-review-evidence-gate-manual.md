# `code-review` 증거 게이트: 사실 확인과 운용 매뉴얼

- 대상: `ultracode-for-codex` 0.6.1 (`main` @ `218a1b9`)
- 확인일: 2026-07-27
- 확인 방법: 소스 독해 + `dist` 재빌드 후 실제 런타임 11케이스 실행 (부록 B 재현 스크립트)
- 이 문서의 독자: ultracode-for-codex를 호출하거나, 그 동작을 사용자에게 설명하는 LLM

---

## Part 1. 검증 대상 주장

> "ultracode는 git status + diff에서 증거 허용목록을 만들어 '방금 바뀐 줄에서 무엇이 깨지는가'를 묻고, git 리포지토리 + 미커밋 변경이 없으면 아예 실행되지 않습니다."

| 주장 조각 | 판정 | 근거 |
| --- | --- | --- |
| git status + diff에서 증거 허용목록을 만든다 | **정확** | `allowedEvidenceRefs` = git status의 `file:` + unstaged/staged/committed diff의 `diff:`/`hunk:` (`workflow-runtime.ts:4195-4198`) |
| 허용목록 밖 인용을 막는다 ("방금 바뀐 줄" 강제) | **정확** | 허용목록 밖 ref를 인용한 발견은 `unsupported evidence ref`로 거부 |
| 미커밋 변경이 없으면 에이전트를 띄우지 않는다 | **정확** | `allowedFileRefs.length === 0` → `fail()` (`workflow-runtime.ts:1321-1322`). 실측 백엔드 호출 0회 |
| **"git 리포지토리가 없으면"이 전제조건이다** | **부정확** | git repo 검사가 존재하지 않음. 비-git은 "변경 ref 0개"로 걸리는 *부수 결과* |
| **"ultracode가" 실행되지 않는다** | **부정확 (범위 과장)** | 게이트는 빌트인 `code-review` 스크립트 안에만 있음. `task`/`batch`/커스텀은 비-git·클린 트리에서도 정상 실행 |
| (누락) 커밋된 변경만 리뷰하는 것도 막힌다 | **원문보다 더 엄격** | `diffBaseRef`를 줘도 워킹트리가 깨끗하면 실패 |
| (누락) 미커밋 변경이 있어도 막히는 경우가 있다 | **원문에 없는 큰 함정** | 변경 파일의 확장자·디렉터리가 허용목록 밖이면 게이트가 세지 않음 (Part 4.6) |

---

## Part 2. 실제 메커니즘

게이트는 **딱 하나**이며, 빌트인 `code-review` 워크플로 스크립트 안에 있습니다.

```js
// src/runtime/workflow-runtime.ts:1321-1322 (code-review 스크립트 본문)
if (allowedFileRefs.length === 0) {
  fail("no reviewable change evidence in the working tree: allowed file refs is empty (0 entries) …");
}
```

`allowedFileRefs`는 증거 컨텍스트에서 `file:`로 시작하는 ref만 모은 것이고, 그 출처는 **`git status`가 보고한 변경/미추적 경로 중 경로 필터를 통과한 것**뿐입니다.

git 리포지토리 여부는 어디서도 검사하지 않습니다.

| 상황 | 런타임 동작 | 위치 |
| --- | --- | --- |
| `git rev-parse --show-toplevel` 실패 | throw 없이 `cwd`로 폴백 | `:4391-4397` |
| `git status` 실패 | throw 없이 `unavailable:git-status:<token>` 증거 토큰으로 기록 | `:4038-4051` |
| 결과 | 변경 경로 0개 → `file:` ref 0개 → 위 게이트에 걸림 | `:1321-1322` |

그래서 비-git 디렉터리의 실패 메시지도 "git repo가 아니다"가 아니라 아래와 같습니다.

```
code-review invalid: no reviewable change evidence in the working tree:
allowed file refs is empty (0 entries) derived from file: entries in the evidence
context (git status changed/untracked paths); populated by uncommitted or
untracked paths in the working tree
```

**커밋은 필요 없습니다.** 커밋이 0개인 repo에서 미추적 파일만 있어도 통과합니다. "최소 1커밋"을 요구하는 것은 `isolation: "worktree"`뿐입니다(`:3243-3246`).

---

## Part 3. 검증 증거

FakeSubagent 백엔드(첫 호출에서 즉시 예외)로 실제 런타임을 구동해, 게이트가 **에이전트 스폰 이전**에 작동하는지 백엔드 호출 수로 확인했습니다.

| # | 조건 | 워크플로 | 결과 | 에이전트 스폰 | 백엔드 호출 |
| --- | --- | --- | --- | --- | --- |
| A | git repo 아님 | `code-review` | 게이트 차단 | ✗ | 0 |
| B | git repo, 깨끗한 트리 | `code-review` | 게이트 차단 | ✗ | 0 |
| C | git repo, 미커밋 `.ts` 변경 | `code-review` | 진행 | ✓ | 1 |
| D | 커밋 0개 repo + 미추적 `.ts` | `code-review` | 진행 | ✓ | 1 |
| E | git repo 아님 | **`task`** | 진행 | ✓ | 1 |
| F | 깨끗한 트리 + `diffBaseRef: "HEAD~1"` | `code-review` | 게이트 차단 | ✗ | 0 |
| G | 미커밋 변경이 `src/App.java`뿐 | `code-review` | 게이트 차단 | ✗ | 0 |
| H | 미커밋 변경이 `Dockerfile`+`Makefile`뿐 | `code-review` | 게이트 차단 | ✗ | 0 |
| I | 미커밋 변경이 `dist/bundle.js`뿐 | `code-review` | 게이트 차단 | ✗ | 0 |
| J | 미커밋 변경이 `src/app.ts` (대조군) | `code-review` | 진행 | ✓ | 1 |
| K | `src/App.java` + `notes.md` | `code-review` | 진행 | ✓ | 1 |

케이스 C·D·E·J·K는 게이트가 무조건 실패하는 것이 아님을 증명하는 **대조군**입니다(음성 대조가 없으면 A·B의 실패는 아무것도 증명하지 못함).

케이스 K와 동일한 워킹트리(`src/App.java`, `notes.md`, `Dockerfile`, `dist/bundle.js` 모두 수정)에서 증거 허용목록을 직접 덤프한 결과:

```
### Allowed Evidence Refs
file:notes.md
```

즉 **`.java`·`Dockerfile`·`dist/*`의 변경은 리뷰에 아예 보이지 않습니다.** 게이트는 `notes.md` 하나로 통과하지만, 리뷰 대상은 `notes.md`뿐입니다.

경로 필터의 경계도 19개 파일을 한 워킹트리에 놓고 허용목록을 덤프해 확인했습니다:

| 포함 | 제외 |
| --- | --- |
| `src/app.ts`, `style.css`, `notes.txt`, `mod.rs` | `src/App.java`, `Makefile`, `Dockerfile`, `schema.sql`, `x.vue` |
| `distribution/a.ts`, `outer/d.ts` (부분 문자열은 무해) | `dist/c.ts`, `src/dist/b.ts`, `out/e.ts`, `nested/build/f.ts`, `coverage/g.json`, `artifacts/h.md` |
| `.github/workflows/ci.yml`, `legacy.JS` (대소문자 무관) | — |

케이스 B는 기존 회귀 테스트가 이미 커버합니다: `test/workflow-runtime.test.mjs:730`.

---

## Part 4. 운용 매뉴얼

### 4.1 실행 전 체크리스트

`code-review`를 띄우기 전에 이 4개를 확인하십시오. 하나라도 어긋나면 토큰을 쓰기 전에 실패합니다.

1. **미커밋/미추적 변경이 존재하는가** — `git status --short`가 비어 있지 않아야 합니다.
2. **그 변경이 허용 확장자에 걸리는가** — 최소 한 개 파일이 4.6의 허용 확장자 목록에 있어야 합니다.
3. **그 변경이 제외 디렉터리 밖에 있는가** — `dist/`, `build/`, `node_modules/` 등만 바뀐 경우는 통과하지 못합니다.
4. **리뷰하려는 파일이 허용목록에 들어오는가** — 게이트 통과와 "내가 원하는 파일이 리뷰된다"는 별개입니다(케이스 K).

권장 사전 확인 (에이전트 토큰 0):

```bash
git -C /path/to/project status --short --untracked-files=all
```

출력에 `.ts/.js/.py/.go/.rs/.md/...` 중 하나가, `dist|build|out|coverage|artifacts|node_modules` 밖 경로로 보이면 진행 가능합니다.

### 4.2 표준 호출

```bash
# 0) 최초 1회 준비 확인 (설치·인증·모델 지원 여부)
npm exec --no -- ultracode-for-codex setup || ultracode-for-codex setup

# 1) 리뷰 실행 (백그라운드)
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --name code-review \
  --cwd /path/to/project \
  --args '{"prompt":"방금 바꾼 인증 경로의 정합성과 회귀 위험을 리뷰","level":"high"}' \
  --permission allow

# 2) 진행 상황 / 결과
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --tail --cwd /path/to/project
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
```

`status <jobId>`가 보고하는 `runId`와 `cwd`는 나중의 resume에 필요한 복구 앵커입니다. 실행 직후 기록해 두십시오.

### 4.3 `--args` 스펙 (`code-review`)

| 키 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `prompt` | string | 내장 기본 프롬프트 | 리뷰 의도. 렌즈 선택에 영향 |
| `level` | `"high"` \| 생략 | 생략 = 깊은 프로파일 | 4.4 참조 |
| `diffBaseRef` | string (커밋-ish) | 없음 | `<base>..HEAD` 커밋 diff를 증거에 **추가**. 게이트를 대체하지는 못함 |

`diffBaseRef`는 CLI 플래그가 아니라 `--args` JSON 안의 키입니다. `--diff-base` 같은 플래그는 존재하지 않습니다.

### 4.4 `level` 프로파일

| | `{"level":"high"}` | 생략 (기본) |
| --- | --- | --- |
| scope effort | `medium` | `xhigh` |
| find/verify effort | `high` | `xhigh` |
| 최대 렌즈 수 | 8 | 10 |
| 렌즈당 후보 상한 | 6 | 8 |
| sweep 단계 | 없음 | 있음 |
| 보고 상한 | 10건 | 15건 |

비용·지연을 줄이려면 `{"level":"high"}`, 정확도를 최대화하려면 생략하십시오.

### 4.5 실패 메시지 해독표

| 메시지 | 원인 | 조치 |
| --- | --- | --- |
| `code-review invalid: no reviewable change evidence in the working tree` | 허용목록에 드는 변경 파일 0개 (비-git, 클린 트리, 확장자/디렉터리 제외 모두 이 메시지) | 4.1 체크리스트로 원인 특정 후 워킹트리를 고쳐서 **재실행**. resume는 도움이 되지 않음 |
| `… includes unsupported evidence ref file:X: not in allowed evidence refs (N entries) …` | 에이전트가 허용목록 밖 파일을 인용 | 정상적인 페일클로즈. 그 파일을 리뷰하려면 해당 파일이 허용목록에 들어오게 만들어야 함 |
| `worktree isolation requires a git repository with at least one commit` | `isolation: "worktree"` 사용 시에만 발생 | git repo + 최초 커밋 생성. `code-review` 자체와 무관 |
| `setup`이 `loggedIn: false` 보고 | Codex 미인증 | 사용자에게 `!codex login` 요청. 런타임이 서브에이전트를 시작할 수 없음 |

게이트 실패는 저널에 재사용할 에이전트 결과가 없으므로 `--resume-from-run-id`의 대상이 아닙니다. 워킹트리를 정리하고 새로 실행하는 것이 정답입니다.

### 4.6 자주 걸리는 함정 4가지

**(1) 확장자 허용목록 — 가장 자주 걸립니다.**

증거로 인정되는 확장자는 다음 18개뿐입니다:

```
.cjs .css .go .html .js .json .jsx .md .mjs .py .rs .sh .toml .ts .tsx .txt .yaml .yml
```

비교는 대소문자를 구분하지 않습니다(`legacy.JS`는 통과). 따라서 `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.c`, `.h`, `.cpp`, `.cs`, `.sql`, `.vue`, `.svelte`, `.tf`, `.proto`, `.env`, `Dockerfile`, `Makefile` 등만 바뀐 변경은 **미커밋 변경이 분명히 있어도** 게이트에 막힙니다(케이스 G·H). 확장자 없는 파일명은 `AGENTS.md`·`README.md`·`package.json` 등 소수의 우선 파일명 예외를 빼면 전부 제외됩니다.

**(2) 제외 디렉터리 — 경로 세그먼트 단위 정확 일치**

경로를 `/`로 쪼갠 **구성요소 중 하나가 다음 이름과 정확히 일치**하면 제외됩니다. 문자열 부분 일치가 아닙니다.

```
.git  .next  .turbo  .ultracode-for-codex  artifacts  build  coverage  dist  node_modules  out
```

| 경로 | 판정 | 이유 |
| --- | --- | --- |
| `dist/c.ts` | 제외 | `dist` 세그먼트 |
| `src/dist/b.ts` | 제외 | 최상위가 아니어도 세그먼트면 제외 |
| `out/e.ts`, `nested/build/f.ts`, `coverage/g.json` | 제외 | 동일 |
| `distribution/a.ts` | **포함** | `dist`는 부분 문자열일 뿐 |
| `outer/d.ts` | **포함** | `out`은 부분 문자열일 뿐 |
| `.github/workflows/ci.yml` | **포함** | 목록에 없는 점디렉터리는 제외 대상이 아님 |

빌드 산출물만 바뀐 상태에서 리뷰를 걸면 실패합니다(케이스 I).

**(3) 게이트 통과 ≠ 원하는 파일이 리뷰됨 — 게다가 에이전트는 그 파일을 봅니다**

허용 확장자 파일 하나만 있어도 게이트는 열립니다. 그러나 허용목록 밖 파일은 증거에 존재하지 않으므로 리뷰되지 않고, 그 파일을 인용한 발견은 `unsupported evidence ref`로 거부됩니다(케이스 K). **게이트가 열렸다고 리뷰 범위가 확보된 것이 아닙니다.**

여기에 비대칭이 하나 더 있습니다. 프롬프트의 `### Git Status` 섹션은 **디렉터리 제외만 적용하고 확장자 필터는 적용하지 않습니다**(`shouldExposeWorkspaceStatusPath`, `:4818-4826`). 실측 출력:

```
?? Dockerfile          ← 상태에는 보이지만 증거 ref는 없음
?? src/App.java        ← 상태에는 보이지만 증거 ref는 없음
?? schema.sql          ← 상태에는 보이지만 증거 ref는 없음
?? src/app.ts          ← 유일하게 인용 가능
?? <excluded path omitted>   ← dist/ build/ coverage/ 등은 이렇게 마스킹됨
```

즉 에이전트는 `src/App.java`가 바뀐 사실을 보면서도 그것을 인용할 수 없습니다. 이 상태에서 `.java` 리뷰를 기대하면, 발견이 나오더라도 페일클로즈에 걸려 버려집니다. 리뷰 범위는 `### Git Status`가 아니라 **`### Allowed Evidence Refs`로 판단하십시오.**

**(4) 커밋된 변경만 리뷰하는 경로는 없음**

`diffBaseRef`가 만드는 것은 `diff:committed:*` / `hunk:committed:*` ref이고, 게이트가 세는 것은 `file:` ref입니다. 따라서 워킹트리가 깨끗하면 `diffBaseRef`를 줘도 실패합니다(케이스 F). `diffBaseRef`는 워킹트리에 변경이 있을 때 **커밋 구간 증거를 덧붙이는** 용도입니다.

### 4.7 `code-review`가 막힐 때의 대안

| 상황 | 대안 |
| --- | --- |
| 허용목록 밖 언어(`.java` 등) 코드를 리뷰해야 함 | 빌트인 `task`를 쓰거나 커스텀 워크플로를 작성. `task`는 증거 게이트가 없고 비-git에서도 실행됨(케이스 E). 단 렌즈 선택·후보 검증·프로버넌스 같은 리뷰 하네스는 제공되지 않음 |
| 이미 커밋된 변경(PR 브랜치 등)을 리뷰해야 함 | `workspaceContext({ includeDiff: true, diffBaseRef })`를 직접 쓰는 커스텀 스크립트를 작성. 또는 사용자에게 변경을 워킹트리로 되돌릴지(예: `git reset --soft <base>`) **확인받고** 진행 — 되돌리기는 사용자 결정 사항이며 임의로 실행하지 말 것 |
| 리뷰가 아니라 분석·계획 | `--name task` (읽기 전용 분석 + 구현 가이드) |

### 4.8 리뷰 이후 금지사항

`code-review`는 리뷰 전용입니다. 발견을 심각도 순으로 제시하고 **멈추십시오.** 수정이 자명해 보여도 파일을 편집하거나 구현 단계를 이어서 시작하지 마십시오. 어떤 발견을 처리할지 사용자에게 묻고, 그것은 별도의 구현 요청으로 다루십시오.

---

## Part 5. 권장 표현

원문을 다음으로 대체하십시오.

> ultracode-for-codex의 빌트인 `code-review`는 `git status` + diff에서 증거 허용목록을 만들어 "방금 바뀐 줄에서 무엇이 깨지는가"를 묻습니다. **워킹트리에 리뷰 가능한 미커밋/미추적 변경이 없으면 에이전트를 하나도 띄우지 않고 실패합니다** — 비-git 디렉터리, 깨끗한 트리, 그리고 변경 파일이 전부 허용 확장자·디렉터리 밖인 경우가 모두 여기에 해당합니다. 단 이 게이트는 `code-review` 한정이며, `task`·`batch`·커스텀 워크플로에는 적용되지 않습니다.

한 문장으로 줄여야 한다면:

> `code-review`는 워킹트리의 미커밋 변경만 리뷰하며, 리뷰할 변경 증거가 없으면 에이전트 실행 전에 실패합니다.

"git 리포지토리가 없으면"이라는 전제조건 표현은 쓰지 마십시오. 구현에 그런 검사가 없고, 실패 원인을 사용자가 잘못 진단하게 만듭니다.

---

## 부록 A. 코드 참조

| 대상 | 위치 (`src/runtime/workflow-runtime.ts`) |
| --- | --- |
| 증거 게이트 | `1321-1322` |
| `level` 프로파일 / caps | `769-774` |
| 워크스페이스 루트 폴백 (비-git) | `4391-4397` |
| `git status` 실패 처리 | `4038-4051` |
| 증거 ref 조립 | `4195-4198` |
| diff/hunk ref 생성 | `4306-4327` |
| 경로 필터 (증거 ref용, 확장자 포함) | `4802-4816` |
| 경로 필터 (Git Status 표시용, 확장자 미적용) | `4818-4826` |
| 세그먼트 정확 일치 판정 | `4810`, `4832-4840` |
| 제외 디렉터리 / 허용 확장자 / 우선 파일 | `665-707` |
| worktree 격리의 git 요구사항 | `3243-3246` |
| 빌트인 목록 (`task`/`code-review`/`batch`) | `718-758` |
| 회귀 테스트 (클린 트리) | `test/workflow-runtime.test.mjs:730` |

## 부록 B. 재현 스크립트

`npm run build` 후 실행합니다. 실제 서브에이전트를 부르지 않으므로 토큰 비용이 없습니다.

```js
// probe.mjs — node probe.mjs
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { WorkflowTaskRegistry } from '<repo>/dist/runtime/workflow-runtime.js';

const x = promisify(execFile);

async function probe(label, files, args = {}) {
  const root = await mkdtemp(join(tmpdir(), 'probe-'));
  const g = (...a) => x('git', a, { cwd: root });
  await g('init');
  await g('config', 'user.email', 'p@e.invalid');
  await g('config', 'user.name', 'P');
  await writeFile(join(root, 'README.md'), '# probe\n');
  await g('add', '.');
  await g('commit', '-m', 'init');
  for (const f of files) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), 'changed\n');
  }
  const backend = {
    name: 'p', model: 'p', calls: 0,
    async generate() { this.calls += 1; throw new Error('STOP'); },
    async close() {},
  };
  const runtime = new WorkflowTaskRegistry({
    backend, cwd: root,
    stateDir: join(root, '.ultracode-for-codex'),
    requestTimeoutMs: 20000,
  });
  const launch = await runtime.launch({ name: 'code-review', args: { prompt: 'Review.', ...args } });
  const events = [];
  for await (const e of runtime.streamEvents(launch.taskId)) events.push(e);
  const s = runtime.get(launch.taskId);
  console.log(label,
    '| gate blocked:', /no reviewable change evidence/.test(s.error ?? ''),
    '| agent.started:', events.some((e) => e.type === 'workflow.agent.started'),
    '| backend calls:', backend.calls);
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}

await probe('clean tree        ', []);
await probe('.ts change        ', ['src/app.ts']);
await probe('.java only        ', ['src/App.java']);
await probe('dist/ only        ', ['dist/bundle.js']);
await probe('clean + diffBase  ', [], { diffBaseRef: 'HEAD' });
```

비-git 케이스는 `git init` 3줄을 생략하면 재현됩니다.

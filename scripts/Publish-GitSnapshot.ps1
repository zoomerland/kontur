[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')]
    [string]$ProjectId,

    [Parameter(Mandatory)]
    [string]$RepositoryPath,

    [string]$MonitorUrl = 'http://127.0.0.1:8766',

    [string]$TokenPath = (Join-Path $PSScriptRoot '..\data\api-token.txt'),

    [string]$OutputPath,

    [ValidateRange(1, 2000)]
    [int]$CommitLimit = 800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
$git = (Get-Command git -ErrorAction Stop).Source

function Invoke-LocalGit {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & $git -c core.quotepath=false -C $repository @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed with exit code ${LASTEXITCODE}: git $($Arguments -join ' ')"
    }
    @($output | ForEach-Object { [string]$_ })
}

$worktreeProbe = @(Invoke-LocalGit -Arguments @('rev-parse', '--is-inside-work-tree'))
if ($worktreeProbe[0].Trim() -ne 'true') {
    throw 'RepositoryPath is not a Git worktree.'
}

$head = @(Invoke-LocalGit -Arguments @('rev-parse', '--verify', 'HEAD'))[0].Trim().ToLowerInvariant()
$branchOutput = & $git -C $repository symbolic-ref --quiet --short HEAD 2>$null
$branchCode = $LASTEXITCODE
if ($branchCode -eq 0) {
    $currentBranch = ([string]$branchOutput).Trim()
} elseif ($branchCode -eq 1) {
    $currentBranch = $null
} else {
    throw "Unable to read current branch; Git exited with $branchCode."
}

$originHead = & $git -C $repository symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
$originHeadCode = $LASTEXITCODE
& $git -C $repository show-ref --verify --quiet refs/heads/main
$mainExists = $LASTEXITCODE -eq 0
& $git -C $repository show-ref --verify --quiet refs/heads/master
$masterExists = $LASTEXITCODE -eq 0
if ($originHeadCode -eq 0) {
    $defaultBranch = ([string]$originHead).Trim() -replace '^origin/', ''
} elseif ($mainExists) {
    $defaultBranch = 'main'
} elseif ($masterExists) {
    $defaultBranch = 'master'
} else {
    $defaultBranch = $currentBranch
}

function Get-RefLayer {
    param([string]$Name, [string]$Kind)
    if ($Kind -eq 'tag' -or $Name -match '(^|/)HEAD$') { return 'formal' }
    if ($Name -match '(?i)(^|[/_-])(docs?|tests?|ci|chore|release|deploy|infra|security|audit|review|migration|bootstrap|repair|fix|hotfix|refactor)([/_-]|$)') {
        return 'technical'
    }
    'work'
}

$refs = @()
$refLines = Invoke-LocalGit -Arguments @(
    'for-each-ref', '--sort=refname',
    '--format=%(refname)%09%(objectname)%09%(*objectname)',
    'refs/heads', 'refs/remotes', 'refs/tags'
)
foreach ($line in $refLines) {
    $parts = $line -split "`t", 3
    if ($parts.Count -lt 2) { continue }
    $fullName = $parts[0]
    if ($fullName.StartsWith('refs/heads/')) {
        $kind = 'local'; $name = $fullName.Substring(11)
    } elseif ($fullName.StartsWith('refs/remotes/')) {
        $kind = 'remote'; $name = $fullName.Substring(13)
    } elseif ($fullName.StartsWith('refs/tags/')) {
        $kind = 'tag'; $name = $fullName.Substring(10)
    } else {
        continue
    }
    $targetOutput = & $git -C $repository rev-parse --verify "$fullName^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $target = ([string]$targetOutput).Trim().ToLowerInvariant()
    $refs += [ordered]@{
        name = $name
        target = $target
        kind = $kind
        layer = Get-RefLayer -Name $name -Kind $kind
        isHead = ($kind -eq 'local' -and $null -ne $currentBranch -and $name -ceq $currentBranch)
    }
}

$refs = @($refs | Sort-Object @{Expression='kind'; Ascending=$true}, @{Expression='name'; Ascending=$true})
if ($refs.Count -gt 500) {
    throw "Repository has $($refs.Count) refs; the API limit is 500. Narrow the repository refs before publishing."
}
$tipCandidates = [System.Collections.Generic.List[string]]::new()
foreach ($ref in $refs) { $tipCandidates.Add([string]$ref.target) }
$tipCandidates.Add($head)
$tips = @($tipCandidates | Sort-Object -Unique)
$tipSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($tip in $tips) { [void]$tipSet.Add([string]$tip) }
if ($tipSet.Count -gt $CommitLimit) {
    throw "Repository has $($tipSet.Count) distinct ref tips; CommitLimit must be at least that large."
}
$reachableCount = [int](@(Invoke-LocalGit -Arguments (@('rev-list', '--count') + $tips))[0])
$logArguments = @(
    'log', '--topo-order', '--no-show-signature',
    '--format=%H%x09%P%x09%cI%x09%s'
) + $tips
$commits = @()
$selectedTips = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$nonTipBudget = $CommitLimit - $tipSet.Count
$selectedNonTips = 0
foreach ($line in (Invoke-LocalGit -Arguments $logArguments)) {
    $parts = $line -split "`t", 4
    if ($parts.Count -ne 4) { throw 'Unexpected git log record.' }
    $commitHash = $parts[0].ToLowerInvariant()
    $isTip = $tipSet.Contains($commitHash)
    if (-not $isTip -and $selectedNonTips -ge $nonTipBudget) { continue }
    $parents = if ([string]::IsNullOrWhiteSpace($parts[1])) { @() } else { @($parts[1].Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)) }
    $commits += [ordered]@{
        hash = $commitHash
        parents = @($parents | ForEach-Object { $_.ToLowerInvariant() })
        committedAt = $parts[2]
        subject = $parts[3]
    }
    if ($isTip) { [void]$selectedTips.Add($commitHash) } else { $selectedNonTips++ }
    if ($selectedTips.Count -eq $tipSet.Count -and $selectedNonTips -ge $nonTipBudget) { break }
}

$dirty = @(Invoke-LocalGit -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')).Count -gt 0
$payload = [ordered]@{
    repository = Split-Path -Leaf $repository
    classificationVersion = 1
    capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
    head = $head
    currentBranch = $currentBranch
    defaultBranch = $defaultBranch
    dirty = $dirty
    truncated = $reachableCount -gt $commits.Count
    refs = $refs
    commits = $commits
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
if ($OutputPath) {
    [System.IO.File]::WriteAllText($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath), $json, [System.Text.UTF8Encoding]::new($false))
    Write-Output "Git snapshot saved locally: commits=$($commits.Count) refs=$($refs.Count) dirty=$dirty"
    return
}

$destination = [Uri]$MonitorUrl
if ($destination.Scheme -notin @('http', 'https') -or $destination.UserInfo -or $destination.Query -or $destination.Fragment) {
    throw 'MonitorUrl must be an HTTP(S) origin without credentials, query, or fragment.'
}
if ($destination.Scheme -eq 'http' -and $destination.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1')) {
    throw 'Non-loopback destinations require HTTPS to protect the API token.'
}
$token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
if ($token.Length -lt 32) { throw 'Monitor token is missing or too short.' }
$base = $MonitorUrl.TrimEnd('/')
$uri = "$base/api/v1/projects/$ProjectId/git"
$auth = @{ Authorization = "Bearer $token" }
$current = Invoke-WebRequest -Uri $uri -Headers $auth -Method Get -SkipHttpErrorCheck
if ($current.StatusCode -eq 200) {
    $gitRevision = [int](($current.Content | ConvertFrom-Json).revision)
} elseif ($current.StatusCode -eq 404) {
    $gitRevision = 0
} else {
    throw "Git snapshot read failed with HTTP $($current.StatusCode)."
}

$headers = @{
    Authorization = "Bearer $token"
    'If-Match' = '"' + $gitRevision + '"'
}
$response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Put `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -SkipHttpErrorCheck
if ($response.StatusCode -ne 200) {
    $detail = try {
        $errorBody = $response.Content | ConvertFrom-Json
        if ($errorBody.detail -is [array]) {
            (@($errorBody.detail | ForEach-Object { [string]$_.msg }) -join '; ')
        } else {
            [string]$errorBody.detail
        }
    } catch { 'No structured error detail.' }
    throw "Git snapshot update failed with HTTP $($response.StatusCode). Detail: $detail Read the latest snapshot before retrying."
}
$result = $response.Content | ConvertFrom-Json
$state = if ($result.unchanged) { 'unchanged' } else { 'updated' }
Write-Output "Git snapshot ${state}: project=$ProjectId revision=$($result.revision) commits=$($result.commits.Count) refs=$($result.refs.Count) dirty=$($result.dirty)"

"""Check and export an explicit public candidate. No Git or network operations."""
import argparse
import ast
import hashlib
import json
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = 'public/manifest.json'
RULES = {
    'private_key': re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'),
    'credential_candidate': re.compile(r'(?i)(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*["\x27]?[^\s"\x27,;]{8,})'),
    'credential_url': re.compile(r'(?i)(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis)://[^\s/:]+:[^\s/@]+@'),
    'quoted_credential_candidate': re.compile(r'(?i)["\x27](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|connection[_-]?string)["\x27]\s*:\s*["\x27][^"\x27]{8,}'),
    'token_format_candidate': re.compile(r'(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[0-9A-Za-z_-]{12,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|Bearer\s+[0-9A-Za-z._-]{16,})'),
    'personal_identifier_candidate': re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)'),
    'local_absolute_path': re.compile(r'(?i)(?<![a-z0-9])(?:[a-z]:[\\/]|/(?:home|Users)/)[^\s]*'),
}


def expected_ignore(paths):
    rules = ['/*']
    directories = {''}
    for name in paths:
        directories.update(p.as_posix() for p in pathlib.PurePosixPath(name).parents if p.as_posix() != '.')
    def walk(directory):
        prefix = directory + '/' if directory else ''
        for name in sorted(p for p in paths if str(pathlib.PurePosixPath(p).parent) == (directory or '.')):
            rules.append('!/' + name)
        children = sorted(d for d in directories if d and str(pathlib.PurePosixPath(d).parent) == (directory or '.'))
        for child in children:
            rules.extend(['!/' + child + '/', '/' + child + '/*'])
            walk(child)
    walk('')
    rules.append('/.local-audit/')
    return rules


def load_and_check():
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding='utf-8'))
    if manifest.get('schema_version') != 1 or manifest.get('publication_status') != 'pending-rights-review':
        raise ValueError('manifest_status_or_schema_invalid')
    entries = manifest['files']
    paths = [e['path'] for e in entries]
    if len(paths) != len(set(paths)) or MANIFEST not in paths:
        raise ValueError('manifest_duplicate_or_missing_self')
    findings, contents = [], {}
    for name in paths:
        pure = pathlib.PurePosixPath(name)
        if pure.is_absolute() or '..' in pure.parts or '\\' in name or pure.as_posix() != name:
            raise ValueError('manifest_path_invalid')
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError('manifest_symlink_or_outside_root')
        if any(parent.is_symlink() for parent in path.parents if parent.is_relative_to(ROOT)):
            raise ValueError('manifest_symlink_parent')
        data = path.read_bytes()
        if len(data) > 5_000_000 or b'\x00' in data:
            raise ValueError('unexpected_binary_or_large_file')
        content = data.decode('utf-8')
        contents[name] = data
        for number, line in enumerate(content.splitlines(), 1):
            for category, rule in RULES.items():
                if rule.search(line):
                    findings.append({'path':name, 'line':number, 'category':category,
                                     'recommendation':'Review and replace with a placeholder before publication.'})
        if name.endswith('.json'):
            json.loads(content)
        if name.endswith('.py'):
            ast.parse(content)
        if name.endswith('.md'):
            for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^)]+)\)', content):
                if target.startswith(('https://', 'http://', '#')):
                    continue
                linked = path.parent / target.split('#', 1)[0]
                if not linked.resolve().is_relative_to(ROOT) or not linked.exists():
                    findings.append({'path':name, 'line':content[:content.find(']('+target+')')].count('\n')+1,
                                     'category':'broken_local_link', 'recommendation':'Fix the local link.'})
    actual = set()
    for directory in ['docs', 'public', 'scripts', 'tests']:
        actual.update(p.relative_to(ROOT).as_posix() for p in (ROOT/directory).rglob('*') if p.is_file())
    extra = actual - set(paths)
    for name in sorted(extra):
        findings.append({'path':name, 'line':None, 'category':'unlisted_candidate_file',
                         'recommendation':'Review explicitly; do not include automatically.'})
    ignore_lines = [line.strip() for line in contents['.gitignore'].decode().splitlines() if line.strip() and not line.startswith('#')]
    if ignore_lines != expected_ignore(paths):
        findings.append({'path':'.gitignore', 'line':None, 'category':'ignore_rules_mismatch',
                         'recommendation':'Synchronize exact rules with the manifest.'})
    if findings:
        for finding in findings:
            print(json.dumps(finding, ensure_ascii=False))
        raise ValueError('candidate_checks_failed')
    return entries, contents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='Validate manifest, text risk patterns, JSON, Python and local links.')
    mode.add_argument('--output', type=pathlib.Path, help='Export into a new directory beneath .local-audit.')
    args = parser.parse_args()
    try:
        entries, contents = load_and_check()
        if args.check:
            print(json.dumps({'status':'passed', 'files':len(entries), 'scope':'public candidate; rights and integration still pending'}))
            return 0
        output = args.output if args.output.is_absolute() else ROOT/args.output
        audit_root = ROOT/'.local-audit'
        if audit_root.is_symlink():
            raise ValueError('audit_directory_symlink')
        audit_root = audit_root.resolve()
        output = output.resolve()
        if not output.is_relative_to(audit_root) or output == audit_root:
            raise ValueError('output_must_be_beneath_local_audit')
        if output.exists():
            raise ValueError('output_exists_no_overwrite')
        output.parent.mkdir(parents=True, exist_ok=True)
        # Stage all bytes in a new local directory. Failed staging is retained.
        stage = pathlib.Path(tempfile.mkdtemp(prefix='candidate-', dir=output.parent))
        for name, data in contents.items():
            destination = stage/name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            if hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(data).digest():
                raise ValueError('copy_integrity_failed')
        stage.rename(output)
        print(json.dumps({'status':'exported', 'files':len(entries), 'path':output.relative_to(ROOT).as_posix(),
                          'publication_status':'pending-rights-review'}))
        return 0
    except (OSError, ValueError, KeyError, TypeError, SyntaxError) as exc:
        # Never print source lines, credential values, or environment details.
        category = str(exc) if type(exc) is ValueError and re.fullmatch('[a-z_]+', str(exc)) else type(exc).__name__
        print(json.dumps({'category':category, 'recommendation':'Resolve the failed check; originals and existing output are retained.'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())

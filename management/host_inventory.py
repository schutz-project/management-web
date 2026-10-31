"""Attach explicit scrape labels; never infer a host role from an address."""
ROLES = {'service': '서비스 서버', 'monitoring': '모니터링 서버'}


def host_inventory(nodes, targets, source_failed=False):
    """Keep legacy hosts, plus missing expected roles as non-numeric entries."""
    result = []
    metadata = {}
    metadata_failed = isinstance(targets, Exception)
    if not metadata_failed:
        for row in targets:
            labels = row.get('metric', {})
            if labels.get('job') == 'ec2-node':
                metadata[labels.get('instance', '')] = labels
    for instance, node in nodes.items():
        labels = metadata.get(instance, {})
        role = labels.get('server_role', 'unknown')
        if role not in ROLES:
            role = 'unknown'
        node.update(server_role=role, server_name=ROLES.get(role, '역할 미지정 서버'),
                    host_id=instance, expected=False,
                    metadata_status='unavailable' if metadata_failed else 'ok')
        result.append(node)
    # Include configured but missing targets, so loss of samples cannot hide them.
    for instance, labels in metadata.items():
        role = labels.get('server_role')
        if instance not in nodes and role in ROLES:
            result.append(dict(instance=instance, host_id=instance, server_role=role,
                               server_name=ROLES[role], expected=True,
                               status='unavailable' if source_failed or metadata_failed else 'no_data',
                               metadata_status='unavailable' if metadata_failed else 'ok',
                               cpu=None, memory=None, disk=None, history={}))
    for role, name in ROLES.items():
        if not any(h['server_role'] == role for h in result):
            result.append(dict(instance=None, host_id='expected:'+role, server_role=role,
                               server_name=name, expected=True,
                               status='unavailable' if source_failed or metadata_failed else 'no_data',
                               metadata_status='unavailable' if metadata_failed else 'ok',
                               cpu=None, memory=None, disk=None, history={}))
    return result

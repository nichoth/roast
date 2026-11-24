export type BuildMeta = { version:string; commit:string }
export type ScopeMeta = {
    kind:string;
    base?:string;
    uncommitted_only?:boolean;
    staged_only?:boolean;
    include_vendored?:boolean;
    paths?:string[];
    excludes?:string[];
    base_oid?:string;
    merge_base_oid?:string;
    head_oid?:string;
    survey?:boolean;
    staged?:boolean;
    files?:string[];
}
export type DerivedMeta = {
    mode:string;
    langs?:string[];
    quick?:boolean;
    interactive:boolean;
    max_turns:number;
    confidence_floor:number;
    do_verify:boolean;
    task?:string;
    max_severity?:string;
    max_diff_bytes?:number;
    max_file_ctx_bytes?:number;
}
export type RoleMeta = {
    profile?:string;
    base_url:string;
    model:string;
    protocol:string;
    api?:string;
    max_output_tokens:number;
    session_header?:string;
    prompt_digest?:string;
}
export type SnapshotMeta = {
    captured:boolean;
    reason?:string;
    ref?:string;
    commit?:string;
    index_tree?:string;
    worktree_tree?:string;
    base_tree?:string;
    head?:string;
    base?:string;
    diff_pair?:string;
    file_modes?:string;
    excluded_paths?:string[];
}
export type DigestMeta = {
    input_kind:string;
    input:string;
    input_bytes:number;
    system_prompt?:string;
    user_prompt?:string;
}
export type UsageMeta = {
    uncached_input_tokens:number;
    cached_input_tokens:number;
    cache_write_tokens:number;
    output_tokens:number;
    calls:number;
}
export type Meta = {
    run_id:string;
    replay_of?:string;
    ts:string;
    repo:string;
    invoke_dir?:string;
    argv?:string[];
    roast:BuildMeta;
    scope:ScopeMeta;
    derived:DerivedMeta;
    roles:Record<string, RoleMeta>;
    snapshot:SnapshotMeta;
    digests:DigestMeta;
    budgets?:Record<string, unknown>;
    usage?:Record<string, UsageMeta>;
    env_names_only?:string[];
    caveats?:string[];
}

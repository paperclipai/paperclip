import { i18n, t } from "@/i18n";
import type { TaskChatMaterializedResourceItem } from "./task-chat-model";

// Only call these helpers for built-in presentation metadata. Protocol models,
// provider payloads, user messages, source code, and persisted content stay raw.
const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  "New session": "sep12Chat.composer.newSession",
  "Waiting to resume": "sep12Chat.marker.waitingToResume",
  "Run interrupted": "localizationTaskThread.runInterrupted",
  "Run completed": "localizationTaskThread.runCompleted",
  "Usage limit reached": "localizationTaskThread.providerUsageLimitReached",
  "create": "localizationTaskRuntime.display.ui_create_aqvqe5",
  "modify": "localizationTaskRuntime.display.ui_modify_1gc94zn",
  "delete": "localizationTaskRuntime.display.ui_delete_ssf22y",
  "rename": "localizationTaskRuntime.display.ui_rename_1020k43",
  "mode change": "localizationTaskRuntime.display.ui_mode_change_1fg4m02",
  "needs review": "localizationTaskRuntime.display.ui_needs_review_dz5mkm",
  "yielded": "localizationTaskRuntime.display.ui_yielded_1rlhdpr",
  "not run": "localizationTaskRuntime.display.ui_not_run_12jjwc7",
  "passed": "localizationTaskRuntime.display.ui_passed_mjgec9",
  "Allow once": "localizationTaskRuntime.display.ui_Allow_once_8ajno3",
  "Allow always": "localizationTaskRuntime.display.ui_Allow_always_1o2mn4j",
  "Deny": "localizationTaskRuntime.display.ui_Deny_269q4n",
  "Applying a patch": "localizationTaskRuntime.display.ui_Applying_a_patch_1d5bb64",
  "Applied a patch": "localizationTaskRuntime.display.ui_Applied_a_patch_xzhhdn",
  "Reading a file": "localizationTaskRuntime.display.ui_Reading_a_file_omxgmu",
  "Read a file": "localizationTaskRuntime.display.ui_Read_a_file_pl77yg",
  "Writing a file": "localizationTaskRuntime.display.ui_Writing_a_file_141x92i",
  "Wrote a file": "localizationTaskRuntime.display.ui_Wrote_a_file_sq1c5x",
  "Editing a file": "localizationTaskRuntime.display.ui_Editing_a_file_ggge7e",
  "Edited a file": "localizationTaskRuntime.display.ui_Edited_a_file_15iopt3",
  "Reading a notebook": "localizationTaskRuntime.display.ui_Reading_a_notebook_1yd2ppt",
  "Read a notebook": "localizationTaskRuntime.display.ui_Read_a_notebook_6ovnjz",
  "Editing a notebook": "localizationTaskRuntime.display.ui_Editing_a_notebook_13ta2nx",
  "Edited a notebook": "localizationTaskRuntime.display.ui_Edited_a_notebook_14sr9i4",
  "Searching files": "localizationTaskRuntime.display.ui_Searching_files_11695y8",
  "Searched files": "localizationTaskRuntime.display.ui_Searched_files_1ju8rpb",
  "Searching file contents": "localizationTaskRuntime.display.ui_Searching_file_contents_au4zt3",
  "Searched file contents": "localizationTaskRuntime.display.ui_Searched_file_contents_id1u8o",
  "Searching available tools": "localizationTaskRuntime.display.ui_Searching_available_tools_3unl4z",
  "Searched available tools": "localizationTaskRuntime.display.ui_Searched_available_tools_qajtog",
  "Searching the web": "localizationTaskRuntime.display.ui_Searching_the_web_12fg67m",
  "Searched the web": "localizationTaskRuntime.display.ui_Searched_the_web_1rv4wat",
  "Fetching a web page": "localizationTaskRuntime.display.ui_Fetching_a_web_page_1d9xjcj",
  "Fetched a web page": "localizationTaskRuntime.display.ui_Fetched_a_web_page_z6s2m",
  "Updating the task list": "localizationTaskRuntime.display.ui_Updating_the_task_list_ethszv",
  "Updated the task list": "localizationTaskRuntime.display.ui_Updated_the_task_list_kik0so",
  "Creating a task": "localizationTaskRuntime.display.ui_Creating_a_task_v5ef7u",
  "Created a task": "localizationTaskRuntime.display.ui_Created_a_task_1yzbbjp",
  "Updating a task": "localizationTaskRuntime.display.ui_Updating_a_task_fwevj5",
  "Updated a task": "localizationTaskRuntime.display.ui_Updated_a_task_1vytke0",
  "Listing tasks": "localizationTaskRuntime.display.ui_Listing_tasks_1r6ks8l",
  "Listed tasks": "localizationTaskRuntime.display.ui_Listed_tasks_1942kbe",
  "Reading a task": "localizationTaskRuntime.display.ui_Reading_a_task_bhgbqt",
  "Read a task": "localizationTaskRuntime.display.ui_Read_a_task_1sqqltf",
  "Entering plan mode": "localizationTaskRuntime.display.ui_Entering_plan_mode_1mjprbd",
  "Entered plan mode": "localizationTaskRuntime.display.ui_Entered_plan_mode_1r6tcmi",
  "Leaving plan mode": "localizationTaskRuntime.display.ui_Leaving_plan_mode_1q07imp",
  "Left plan mode": "localizationTaskRuntime.display.ui_Left_plan_mode_1wrdb9y",
  "Loading a skill": "localizationTaskRuntime.display.ui_Loading_a_skill_xvxvrt",
  "Loaded a skill": "localizationTaskRuntime.display.ui_Loaded_a_skill_85lvsi",
  "Requesting input": "localizationTaskRuntime.display.ui_Requesting_input_4ser1a",
  "Requested input": "localizationTaskRuntime.display.ui_Requested_input_17okrnj",
  "Starting a subagent": "localizationTaskRuntime.display.ui_Starting_a_subagent_3a694p",
  "Started a subagent": "localizationTaskRuntime.display.ui_Started_a_subagent_11tqgs",
  "Checking subagent progress": "localizationTaskRuntime.display.ui_Checking_subagent_progress_rwqhwv",
  "Checked subagent progress": "localizationTaskRuntime.display.ui_Checked_subagent_progress_1iv39p8",
  "Stopping a subagent": "localizationTaskRuntime.display.ui_Stopping_a_subagent_obiv7t",
  "Stopped a subagent": "localizationTaskRuntime.display.ui_Stopped_a_subagent_ko4mgc",
  "Messaging a subagent": "localizationTaskRuntime.display.ui_Messaging_a_subagent_1e4a6pv",
  "Messaged a subagent": "localizationTaskRuntime.display.ui_Messaged_a_subagent_zaijaq",
  "Checking task progress": "localizationTaskRuntime.display.ui_Checking_task_progress_1lbf3e1",
  "Checked task progress": "localizationTaskRuntime.display.ui_Checked_task_progress_dt5wta",
  "Interrupting a subagent": "localizationTaskRuntime.display.ui_Interrupting_a_subagent_1ldkdze",
  "Interrupted a subagent": "localizationTaskRuntime.display.ui_Interrupted_a_subagent_1mfzvw1",
  "Reporting findings": "localizationTaskRuntime.display.ui_Reporting_findings_im0zq5",
  "Reported findings": "localizationTaskRuntime.display.ui_Reported_findings_ninp98",
  "Reviewing safety": "localizationTaskRuntime.display.ui_Reviewing_safety_2tmlfj",
  "Reviewed safety": "localizationTaskRuntime.display.ui_Reviewed_safety_1wctme6",
  "Inspecting code intelligence": "localizationTaskRuntime.display.ui_Inspecting_code_intelligence_17610at",
  "Inspected code intelligence": "localizationTaskRuntime.display.ui_Inspected_code_intelligence_1jxroii",
  "Compacting context": "localizationTaskRuntime.display.ui_Compacting_context_1ikuart",
  "Compacted context": "localizationTaskRuntime.display.ui_Compacted_context_i3si3g",
  "Generating an image": "localizationTaskRuntime.display.ui_Generating_an_image_1duonbl",
  "Generated an image": "localizationTaskRuntime.display.ui_Generated_an_image_1f40rnc",
  "Viewing an image": "localizationTaskRuntime.display.ui_Viewing_an_image_fynhii",
  "Viewed an image": "localizationTaskRuntime.display.ui_Viewed_an_image_e93hz1",
  "Running tools in parallel": "localizationTaskRuntime.display.ui_Running_tools_in_parallel_smdvp",
  "Ran tools in parallel": "localizationTaskRuntime.display.ui_Ran_tools_in_parallel_c5ynmr",
  "Reading task context": "localizationTaskRuntime.display.ui_Reading_task_context_pkpq77",
  "Read task context": "localizationTaskRuntime.display.ui_Read_task_context_10ifh59",
  "Reading task history": "localizationTaskRuntime.display.ui_Reading_task_history_1ef5l9k",
  "Read task history": "localizationTaskRuntime.display.ui_Read_task_history_1mdmhnm",
  "Listing documents": "localizationTaskRuntime.display.ui_Listing_documents_1a0p64t",
  "Listed documents": "localizationTaskRuntime.display.ui_Listed_documents_1hot5g6",
  "Reading a document": "localizationTaskRuntime.display.ui_Reading_a_document_1geche1",
  "Read a document": "localizationTaskRuntime.display.ui_Read_a_document_ju1aoj",
  "Listing document revisions": "localizationTaskRuntime.display.ui_Listing_document_revisions_1ynzcvi",
  "Listed document revisions": "localizationTaskRuntime.display.ui_Listed_document_revisions_tjppb7",
  "Reporting progress": "localizationTaskRuntime.display.ui_Reporting_progress_8puors",
  "Reported progress": "localizationTaskRuntime.display.ui_Reported_progress_1xvlh5d",
  "Answering a status question": "localizationTaskRuntime.display.ui_Answering_a_status_question_mx20hs",
  "Answered a status question": "localizationTaskRuntime.display.ui_Answered_a_status_question_1l2fp17",
  "Writing a document": "localizationTaskRuntime.display.ui_Writing_a_document_o5adal",
  "Wrote a document": "localizationTaskRuntime.display.ui_Wrote_a_document_udppq6",
  "Registering a deliverable": "localizationTaskRuntime.display.ui_Registering_a_deliverable_kt0zda",
  "Registered a deliverable": "localizationTaskRuntime.display.ui_Registered_a_deliverable_1lxva2b",
  "Reporting completion": "localizationTaskRuntime.display.ui_Reporting_completion_107pkpl",
  "Reported completion": "localizationTaskRuntime.display.ui_Reported_completion_m83rb0",
  "Reporting a blocker": "localizationTaskRuntime.display.ui_Reporting_a_blocker_2yq4dc",
  "Reported a blocker": "localizationTaskRuntime.display.ui_Reported_a_blocker_26lwxr",
  "Requesting review": "localizationTaskRuntime.display.ui_Requesting_review_1bwkij6",
  "Requested review": "localizationTaskRuntime.display.ui_Requested_review_1bnmxb9",
  "Listing agents": "localizationTaskRuntime.display.ui_Listing_agents_n40jon",
  "Listed agents": "localizationTaskRuntime.display.ui_Listed_agents_1helvqm",
  "Reading agent details": "localizationTaskRuntime.display.ui_Reading_agent_details_18qrtw4",
  "Read agent details": "localizationTaskRuntime.display.ui_Read_agent_details_1obnjje",
  "Searching tasks": "localizationTaskRuntime.display.ui_Searching_tasks_e30lr1",
  "Searched tasks": "localizationTaskRuntime.display.ui_Searched_tasks_5rs8nm",
  "Listing approvals": "localizationTaskRuntime.display.ui_Listing_approvals_8clojr",
  "Listed approvals": "localizationTaskRuntime.display.ui_Listed_approvals_624s2g",
  "Reading an approval": "localizationTaskRuntime.display.ui_Reading_an_approval_16unl4l",
  "Read an approval": "localizationTaskRuntime.display.ui_Read_an_approval_13ym2j3",
  "Reading approval context": "localizationTaskRuntime.display.ui_Reading_approval_context_1e235c9",
  "Read approval context": "localizationTaskRuntime.display.ui_Read_approval_context_pwhqk7",
  "Reading workspace status": "localizationTaskRuntime.display.ui_Reading_workspace_status_16zoxjc",
  "Read workspace status": "localizationTaskRuntime.display.ui_Read_workspace_status_66u4k6",
  "Controlling a workspace service": "localizationTaskRuntime.display.ui_Controlling_a_workspace_service_1yy9rxj",
  "Controlled a workspace service": "localizationTaskRuntime.display.ui_Controlled_a_workspace_service_fsgxkm",
  "Updating task dependencies": "localizationTaskRuntime.display.ui_Updating_task_dependencies_hwl8fl",
  "Updated task dependencies": "localizationTaskRuntime.display.ui_Updated_task_dependencies_a7zgh6",
  "Requesting approval": "localizationTaskRuntime.display.ui_Requesting_approval_qvrusp",
  "Requested approval": "localizationTaskRuntime.display.ui_Requested_approval_184f8ci",
  "Deciding an approval": "localizationTaskRuntime.display.ui_Deciding_an_approval_95eqag",
  "Decided an approval": "localizationTaskRuntime.display.ui_Decided_an_approval_gvxexl",
  "Commenting on an approval": "localizationTaskRuntime.display.ui_Commenting_on_an_approval_if36h5",
  "Commented on an approval": "localizationTaskRuntime.display.ui_Commented_on_an_approval_z207im",
  "Scheduling a wake-up": "localizationTaskRuntime.display.ui_Scheduling_a_wake_up_pveuwm",
  "Scheduled a wake-up": "localizationTaskRuntime.display.ui_Scheduled_a_wake_up_1mt4rz5",
  "Calling the Paperclip API": "localizationTaskRuntime.display.ui_Calling_the_Paperclip_API_1u45tls",
  "Called the Paperclip API": "localizationTaskRuntime.display.ui_Called_the_Paperclip_API_1hmyx4b",
  "Running a command": "localizationTaskRuntime.display.ui_Running_a_command_lr883u",
  "Ran a command": "localizationTaskRuntime.display.ui_Ran_a_command_11716xk",
  "Waiting": "localizationTaskRuntime.display.ui_Waiting_1jufdxk",
  "Finished waiting": "localizationTaskRuntime.display.ui_Finished_waiting_13t1z9g",
  "Thinking": "localizationTaskRuntime.display.ui_Thinking_jkajtp",
  "Finished thinking": "localizationTaskRuntime.display.ui_Finished_thinking_1veo4gx",
  "Running": "localizationTaskRuntime.display.ui_Running_j6ts6k",
  "Working": "localizationTaskRuntime.display.ui_Working_1pyssg8",
  "Ran": "localizationTaskRuntime.display.ui_Ran_1c5f6vq",
  "Unnamed tool": "localizationTaskRuntime.display.ui_Unnamed_tool_1eon7tr",
  "Running an unnamed tool": "localizationTaskRuntime.display.ui_Running_an_unnamed_tool_i0txtv",
  "Ran an unnamed tool": "localizationTaskRuntime.display.ui_Ran_an_unnamed_tool_1j1sfrt",
  "Opening a web page": "localizationTaskRuntime.display.ui_Opening_a_web_page_cl4z7x",
  "Opened a web page": "localizationTaskRuntime.display.ui_Opened_a_web_page_79u2x8",
  "Couldn’t open the web page": "localizationTaskRuntime.display.ui_Couldn_t_open_the_web_page_1f1im7d",
  "Stopped opening the web page": "localizationTaskRuntime.display.ui_Stopped_opening_the_web_page_lf11my",
  "Searching the page": "localizationTaskRuntime.display.ui_Searching_the_page_1p6b4n3",
  "Searched the page": "localizationTaskRuntime.display.ui_Searched_the_page_1vfjfya",
  "Page search failed": "localizationTaskRuntime.display.ui_Page_search_failed_kki49r",
  "Page search stopped": "localizationTaskRuntime.display.ui_Page_search_stopped_1p3l2zn",
  "Web search failed": "localizationTaskRuntime.display.ui_Web_search_failed_1hnuo8w",
  "Web search stopped": "localizationTaskRuntime.display.ui_Web_search_stopped_1ss619e",
  "Updating the plan": "localizationTaskRuntime.display.ui_Updating_the_plan_1rd9l6v",
  "Updated the plan": "localizationTaskRuntime.display.ui_Updated_the_plan_13xs4zi",
  "Plan update failed": "localizationTaskRuntime.display.ui_Plan_update_failed_i2k5ks",
  "Plan update stopped": "localizationTaskRuntime.display.ui_Plan_update_stopped_trgzfa",
  "Subagent message failed": "localizationTaskRuntime.display.ui_Subagent_message_failed_g98tza",
  "Subagent message stopped": "localizationTaskRuntime.display.ui_Subagent_message_stopped_1ybgn7k",
  "Resuming a subagent": "localizationTaskRuntime.display.ui_Resuming_a_subagent_hq810d",
  "Resumed a subagent": "localizationTaskRuntime.display.ui_Resumed_a_subagent_hr7n2g",
  "Couldn’t resume the subagent": "localizationTaskRuntime.display.ui_Couldn_t_resume_the_subagent_1acbxae",
  "Subagent resume stopped": "localizationTaskRuntime.display.ui_Subagent_resume_stopped_thuk50",
  "Closing a subagent": "localizationTaskRuntime.display.ui_Closing_a_subagent_15qsmna",
  "Closed a subagent": "localizationTaskRuntime.display.ui_Closed_a_subagent_13edf9x",
  "Couldn’t close the subagent": "localizationTaskRuntime.display.ui_Couldn_t_close_the_subagent_udyei5",
  "Subagent close stopped": "localizationTaskRuntime.display.ui_Subagent_close_stopped_u1zuk7",
  "Waiting for subagents": "localizationTaskRuntime.display.ui_Waiting_for_subagents_10ygl1b",
  "Finished waiting for subagents": "localizationTaskRuntime.display.ui_Finished_waiting_for_subagents_g9p5oj",
  "Subagent wait failed": "localizationTaskRuntime.display.ui_Subagent_wait_failed_9chvlw",
  "Stopped waiting for subagents": "localizationTaskRuntime.display.ui_Stopped_waiting_for_subagents_sq767y",
  "Subagent start failed": "localizationTaskRuntime.display.ui_Subagent_start_failed_nqum0f",
  "Subagent start stopped": "localizationTaskRuntime.display.ui_Subagent_start_stopped_tuwm4z",
  "Switching models": "localizationTaskRuntime.display.ui_Switching_models_1888lub",
  "Switched models": "localizationTaskRuntime.display.ui_Switched_models_zhw6pu",
  "Model switch failed": "localizationTaskRuntime.display.ui_Model_switch_failed_71ro8j",
  "Model switch stopped": "localizationTaskRuntime.display.ui_Model_switch_stopped_6exk3j",
  "Verifying the model": "localizationTaskRuntime.display.ui_Verifying_the_model_sq8b5e",
  "Verified the model": "localizationTaskRuntime.display.ui_Verified_the_model_e0li7v",
  "Model verification failed": "localizationTaskRuntime.display.ui_Model_verification_failed_rs9rm6",
  "Model verification stopped": "localizationTaskRuntime.display.ui_Model_verification_stopped_1otxqw8",
  "Context compaction failed": "localizationTaskRuntime.display.ui_Context_compaction_failed_b2eddy",
  "Context compaction stopped": "localizationTaskRuntime.display.ui_Context_compaction_stopped_326gow",
  "Viewing an artifact": "localizationTaskRuntime.display.ui_Viewing_an_artifact_19p5fyr",
  "Viewed an artifact": "localizationTaskRuntime.display.ui_Viewed_an_artifact_al8xki",
  "Couldn’t view the artifact": "localizationTaskRuntime.display.ui_Couldn_t_view_the_artifact_yynu21",
  "Artifact view stopped": "localizationTaskRuntime.display.ui_Artifact_view_stopped_qky7hp",
  "Generating an artifact": "localizationTaskRuntime.display.ui_Generating_an_artifact_pn7fn2",
  "Generated an artifact": "localizationTaskRuntime.display.ui_Generated_an_artifact_mgnpml",
  "Artifact generation failed": "localizationTaskRuntime.display.ui_Artifact_generation_failed_1a733s",
  "Artifact generation stopped": "localizationTaskRuntime.display.ui_Artifact_generation_stopped_1uk9t16",
  "Leaving review mode": "localizationTaskRuntime.display.ui_Leaving_review_mode_1ctjb1c",
  "Left review mode": "localizationTaskRuntime.display.ui_Left_review_mode_vbo7nz",
  "Couldn’t leave review mode": "localizationTaskRuntime.display.ui_Couldn_t_leave_review_mode_1mwfkk1",
  "Review-mode change stopped": "localizationTaskRuntime.display.ui_Review_mode_change_stopped_150tv44",
  "Entering review mode": "localizationTaskRuntime.display.ui_Entering_review_mode_1005saw",
  "Entered review mode": "localizationTaskRuntime.display.ui_Entered_review_mode_8ap7w3",
  "Couldn’t enter review mode": "localizationTaskRuntime.display.ui_Couldn_t_enter_review_mode_gva520",
  "Running a hook": "localizationTaskRuntime.display.ui_Running_a_hook_1uhmh4i",
  "Ran a hook": "localizationTaskRuntime.display.ui_Ran_a_hook_w70ro",
  "Hook failed": "localizationTaskRuntime.display.ui_Hook_failed_92jv7j",
  "Hook stopped": "localizationTaskRuntime.display.ui_Hook_stopped_zvy5c3",
  "Checking memory": "localizationTaskRuntime.display.ui_Checking_memory_myj1do",
  "Referenced memory": "localizationTaskRuntime.display.ui_Referenced_memory_1wv0mq1",
  "Memory lookup failed": "localizationTaskRuntime.display.ui_Memory_lookup_failed_1tyfx09",
  "Memory lookup stopped": "localizationTaskRuntime.display.ui_Memory_lookup_stopped_17bvx39",
  "Safety review failed": "localizationTaskRuntime.display.ui_Safety_review_failed_dxlvji",
  "Safety review stopped": "localizationTaskRuntime.display.ui_Safety_review_stopped_ruvbns",
  "Sending terminal input": "localizationTaskRuntime.display.ui_Sending_terminal_input_1xbwh0b",
  "Sent terminal input": "localizationTaskRuntime.display.ui_Sent_terminal_input_yl511l",
  "Terminal input failed": "localizationTaskRuntime.display.ui_Terminal_input_failed_snx0jy",
  "Terminal input stopped": "localizationTaskRuntime.display.ui_Terminal_input_stopped_1nxmj54",
  "Wait failed": "localizationTaskRuntime.display.ui_Wait_failed_14gnz1x",
  "Wait stopped": "localizationTaskRuntime.display.ui_Wait_stopped_war9i1",
  "Provider notice": "localizationTaskRuntime.display.ui_Provider_notice_vsu4yo",
  "Provider error": "localizationTaskRuntime.display.ui_Provider_error_cxkkxu",
  "Editing files": "localizationTaskRuntime.display.ui_Editing_files_4gnf14",
  "Edited files": "localizationTaskRuntime.display.ui_Edited_files_vo0wuf",
  "Referencing a file": "localizationTaskRuntime.display.ui_Referencing_a_file_15bua34",
  "Referenced a file": "localizationTaskRuntime.display.ui_Referenced_a_file_ekezuh",
  "Saving a resource": "localizationTaskRuntime.display.ui_Saving_a_resource_1u49n30",
  "Added a document": "localizationTaskRuntime.display.ui_Added_a_document_t8d1pv",
  "Added a deliverable": "localizationTaskRuntime.display.ui_Added_a_deliverable_9ul3db",
  "Responding": "localizationTaskRuntime.display.ui_Responding_mcqydm",
  "Responding (streaming)": "localizationTaskRuntime.display.ui_Responding_streaming_1pt4bkt",
  "Queued": "localizationTaskRuntime.display.ui_Queued_17wun3o",
  "Queued...": "localizationTaskRuntime.display.ui_Queued_u04tey",
  "Working...": "localizationTaskRuntime.display.ui_Working_tx9t2m",
  "Run failed": "localizationTaskRuntime.display.ui_Run_failed_1qwj1un",
  "Run timed out": "localizationTaskRuntime.display.ui_Run_timed_out_1chh2yl",
  "Run cancelled": "localizationTaskRuntime.display.ui_Run_cancelled_137hdc9",
  "Run finished": "localizationTaskRuntime.display.ui_Run_finished_6lpgzk",
  "Run started": "localizationTaskRuntime.display.ui_Run_started_1jlj4lr",
  "Run paused": "localizationTaskRuntime.display.ui_Run_paused_17a5nxw",
  "Turn started": "localizationTaskRuntime.display.ui_Turn_started_743h6n",
  "Turn completed": "localizationTaskRuntime.display.ui_Turn_completed_rz6w0z",
  "Finished work": "localizationTaskRuntime.display.ui_Finished_work_131omes",
  "Awaiting approval": "localizationTaskRuntime.display.ui_Awaiting_approval_16n26pe",
  "Provider session total": "localizationTaskRuntime.display.ui_Provider_session_total_buh1qi",
  "Interrupted by board": "localizationTaskRuntime.display.ui_Interrupted_by_board_1tvp8be",
  "Paused by board": "localizationTaskRuntime.display.ui_Paused_by_board_1r4kx68",
  "Stopped": "localizationTaskRuntime.display.ui_Stopped_118y86m",
  "Completed": "localizationTaskRuntime.display.ui_Completed_1tmo59u",
  "Interrupted": "localizationTaskRuntime.display.ui_Interrupted_1cnyep",
  "Refused": "localizationTaskRuntime.display.ui_Refused_14bph1f",
  "Truncated": "localizationTaskRuntime.display.ui_Truncated_t5okp5",
  "Plan": "localizationTaskRuntime.display.ui_Plan_8icj76",
  "Clipping": "localizationTaskRuntime.display.ui_Clipping_qcjkhb",
  "Organizing": "localizationTaskRuntime.display.ui_Organizing_1i3sman",
  "Sorting": "localizationTaskRuntime.display.ui_Sorting_1cquokv",
  "Synthesizing": "localizationTaskRuntime.display.ui_Synthesizing_6eg37q",
  "Analyzing": "localizationTaskRuntime.display.ui_Analyzing_192oevo",
  "Filing": "localizationTaskRuntime.display.ui_Filing_eqw22s",
  "Collating": "localizationTaskRuntime.display.ui_Collating_3obmha",
  "Stapling": "localizationTaskRuntime.display.ui_Stapling_1p5phyz",
  "Indexing": "localizationTaskRuntime.display.ui_Indexing_ewxf9p",
  "Annotating": "localizationTaskRuntime.display.ui_Annotating_1cb83xm",
  "Drafting": "localizationTaskRuntime.display.ui_Drafting_m6pjrg",
  "Proofreading": "localizationTaskRuntime.display.ui_Proofreading_5w1ddj",
  "Alphabetizing": "localizationTaskRuntime.display.ui_Alphabetizing_il3ubb",
  "Photocopying": "localizationTaskRuntime.display.ui_Photocopying_cbocie",
  "Laminating": "localizationTaskRuntime.display.ui_Laminating_uwljp5",
  "Hole-punching": "localizationTaskRuntime.display.ui_Hole_punching_164rcxu",
  "Bookmarking": "localizationTaskRuntime.display.ui_Bookmarking_1t93e1z",
  "Highlighting": "localizationTaskRuntime.display.ui_Highlighting_naaalt",
  "Typing": "localizationTaskRuntime.display.ui_Typing_1cor4h2",
  "Trimming": "localizationTaskRuntime.display.ui_Trimming_1egh8x8",
  "Aligning": "localizationTaskRuntime.display.ui_Aligning_rgcuz6",
  "Combining": "localizationTaskRuntime.display.ui_Combining_lmpb2l",
  "Whiteboarding": "localizationTaskRuntime.display.ui_Whiteboarding_1su7fle",
  "Diagramming": "localizationTaskRuntime.display.ui_Diagramming_1t9xhjj",
  "Sketching": "localizationTaskRuntime.display.ui_Sketching_hvsltj",
  "Labeling": "localizationTaskRuntime.display.ui_Labeling_14s1hab",
  "Sticky-noting": "localizationTaskRuntime.display.ui_Sticky_noting_1h8wft2",
  "Brewing": "localizationTaskRuntime.display.ui_Brewing_1n51xi3",
  "Tinkering": "localizationTaskRuntime.display.ui_Tinkering_1opsfs6",
  "Distilling": "localizationTaskRuntime.display.ui_Distilling_1lyd7ao",
  "Deliberating": "localizationTaskRuntime.display.ui_Deliberating_fprm89",
  "Query": "localizationTaskRuntime.display.ui_Query_17zlk03",
  "URL": "localizationTaskRuntime.display.ui_URL_wksj0e",
  "Target": "localizationTaskRuntime.display.ui_Target_12ohkdk",
  "Name": "localizationTaskRuntime.display.ui_Name_4el6o6",
  "Reference": "localizationTaskRuntime.display.ui_Reference_1c7vrcq",
  "Reason": "localizationTaskRuntime.display.ui_Reason_i36sl5",
  "Summary": "localizationTaskRuntime.display.ui_Summary_i4c62b",
  "Action": "localizationTaskRuntime.display.ui_Action_2wk0tb",
  "Progress": "localizationTaskRuntime.display.ui_Progress_79u6hy",
  "Transport": "localizationTaskRuntime.display.ui_Transport_113o52q",
  "Namespace": "localizationTaskRuntime.display.ui_Namespace_1n5ehq8",
  "Operation": "localizationTaskRuntime.display.ui_Operation_9b62sm",
  "State": "localizationTaskRuntime.display.ui_State_8awmmu",
  "Status": "localizationTaskRuntime.display.ui_Status_3pd73",
  "Intent": "localizationTaskRuntime.display.ui_Intent_kdk7sb",
  "Revision": "localizationTaskRuntime.display.ui_Revision_1pi2b08",
  "Document Revision": "localizationTaskRuntime.display.ui_Document_Revision_1rjozs1",
  "Source": "localizationTaskRuntime.display.ui_Source_r5qyuw",
  "Tool": "localizationTaskRuntime.display.ui_Tool_1m5xsdj",
  "Model": "localizationTaskRuntime.display.ui_Model_107rbay",
  "Provider": "localizationTaskRuntime.display.ui_Provider_evz7q4",
  "Request ID": "localizationTaskRuntime.display.ui_Request_ID_4p7yob",
  "Result": "localizationTaskRuntime.display.ui_Result_ma0s3o",
  "Error": "localizationTaskRuntime.display.ui_Error_1vks92p",
  "Duration": "localizationTaskRuntime.display.ui_Duration_1n1dulp",
  "Input": "localizationTaskRuntime.display.ui_Input_189z5sr",
  "Output": "localizationTaskRuntime.display.ui_Output_1u5xhd0",
  "Type": "localizationTaskRuntime.display.ui_Type_1m2zofh",
  "Session": "localizationTaskRuntime.display.ui_Session_8yh9jr",
  "Session ID": "localizationTaskRuntime.display.ui_Session_ID_1ql4ywg",
  "Connection": "localizationTaskRuntime.display.ui_Connection_2r1h4p",
  "Format": "localizationTaskRuntime.display.ui_Format_1yy1302",
  "Path": "localizationTaskRuntime.display.ui_Path_1tbd3yu",
  "Size": "localizationTaskRuntime.display.ui_Size_1a4x3zw",
  "Command": "localizationTaskRuntime.display.ui_Command_1j2mkia",
  "Exit code": "localizationTaskRuntime.display.ui_Exit_code_8hlrzi",
  "Mode": "localizationTaskRuntime.display.ui_Mode_n44ilu",
  "Policy": "localizationTaskRuntime.display.ui_Policy_1g6zau7",
  "Decision": "localizationTaskRuntime.display.ui_Decision_1gvmqkj",
  "Host": "localizationTaskRuntime.display.ui_Host_dd4txr",
  "Permission": "localizationTaskRuntime.display.ui_Permission_177ws9u",
  "Permissions": "localizationTaskRuntime.display.ui_Permissions_11gikqr",
  "Agent": "localizationTaskRuntime.display.ui_Agent_1w5o8jq",
  "Agents": "localizationTaskRuntime.display.ui_Agents_1sa8ub3",
  "Branch": "localizationTaskRuntime.display.ui_Branch_19gzx45",
  "Workspace": "localizationTaskRuntime.display.ui_Workspace_aw4cba",
  "Resource": "localizationTaskRuntime.display.ui_Resource_9wi711",
  "Kind": "localizationTaskRuntime.display.ui_Kind_hqumoz",
  "Title": "localizationTaskRuntime.display.ui_Title_a7vsmh",
  "Artifact": "localizationTaskRuntime.display.ui_Artifact_1la8ksj",
  "Document": "localizationTaskRuntime.display.ui_Document_1wvusj8",
  "Deliverable": "localizationTaskRuntime.display.ui_Deliverable_5bbzia"
};

export function taskChatDisplayLabel(value: string): string {
  const key = DISPLAY_KEYS[value];
  return key ? t(key) : value;
}

/** Format raw source time at render time; canonical/model timestamps stay unchanged. */
export function taskChatTimestampDisplay(
  value: string | Date | number | undefined,
  fallback: string | undefined,
): string | undefined {
  // English retains the exact upstream string, including host locale conventions.
  // Opaque/provider-authored timestamps without a raw source are never parsed.
  if (!fallback || !i18n.resolvedLanguage?.startsWith("ru") || value == null) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleTimeString(i18n.resolvedLanguage, { hour: "numeric", minute: "2-digit" });
}

/** The transcript keeps its compact English counter for exports and parsing. */
export function taskChatTokenLabel(value: string): string {
  if (!i18n.resolvedLanguage?.startsWith("ru")) return value;
  const match = /^(\d+(?:\.\d+)?)([km])? tokens?$/.exec(value);
  if (!match) return value;
  const count = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
  return t("localizationTaskRuntime.tokenCount", { count, value: new Intl.NumberFormat(i18n.resolvedLanguage, { notation: "compact", maximumFractionDigits: 1 }).format(count) });
}

export function taskChatEnumLabel(value: string): string {
  return t(`status.${value}`, { defaultValue: taskChatDisplayLabel(value.replace(/_/g, " ")) });
}

/** Format a duration label without changing the model's stable English value. */
export function taskChatDurationLabel(value: string): string {
  if (!i18n.resolvedLanguage?.startsWith("ru")) return value;
  const units: Record<string, string> = {
    s: "s", m: "m", h: "h", d: "d",
    second: "s", seconds: "s", minute: "m", minutes: "m",
    hour: "h", hours: "h", day: "d", days: "d",
  };
  return value.replace(/\b(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|[smhd])\b/g, (_, raw: string, unit: string) => {
    const number = Number(raw);
    const key = units[unit];
    // Compact units work both independently and after Russian prepositions
    // (за / через / после / в течение) without noun-case mismatches.
    return t(`localizationTaskRuntime.durationShort_${key}`, { value: new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: raw.includes(".") ? raw.split(".")[1]!.length : 0 }).format(number) });
  });
}

/** Labels generated by the tool taxonomy; never pass tool arguments or results. */
export function taskChatToolActivityLabel(value: string): string {
  const direct = taskChatDisplayLabel(value);
  if (direct !== value) return direct;
  const suffix = /^(.*) · (failed|stopped|interrupted)$/.exec(value);
  if (suffix) return t(`localizationTaskRuntime.toolSuffix_${suffix[2]}`, { action: taskChatToolActivityLabel(suffix[1]) });
  const match = /^(Reading|Read|Listing|Listed|Searching|Searched|Fetching|Fetched|Opening|Opened|Updating|Updated|Creating|Created|Deleting|Deleted|Moving|Moved|Requesting|Requested|Posting|Posted|Starting|Started|Stopping|Stopped|Switching|Switched|Running|Ran) (.+)$/.exec(value);
  if (!match) return direct;
  const objectKeys: Record<string, string> = { data: "data", items: "items", "an item": "item", input: "input", "an update": "update", "an operation": "operation", mode: "mode" };
  const target = objectKeys[match[2]] ? t(`localizationTaskRuntime.toolObject_${objectKeys[match[2]]}`) : match[2];
  return t(`localizationTaskRuntime.toolVerb_${match[1]}`, { target });
}

/** Only for generated thread labels; user/provider titles must bypass this map. */
const THREAD_LABEL_KEYS: Readonly<Record<string, string>> = {
  "Questions": "questions",
  "Suggested tasks": "suggestedTasks",
  "Choose options": "chooseOptions",
  "Review items": "reviewItems",
  "Connect service": "connectService",
  "Review plan": "reviewPlan",
  "Approve tool action": "approveTool",
  "Review secret proposal": "reviewSecret",
  "Confirmation": "confirmation",
  "Runtime permission": "runtimePermission",
  "Runtime input": "runtimeInput",
};

export function taskThreadBuiltinLabel(value: string): string {
  const key = THREAD_LABEL_KEYS[value];
  return key ? t(`localizationTaskThread.${key}`) : value;
}

/** Raw errors remain suitable for callbacks; translate known UI failures on render. */
export function taskThreadErrorDisplay(value: string): string {
  const keys: Readonly<Record<string, string>> = {
    "This queued message is no longer editable.": "queuedNotEditable",
    "This runtime request is missing the provider turn identity needed to resolve it.": "runtimeIdentityMissing",
    "This runtime permission does not accept submitted form data.": "runtimeFormNotAccepted",
    "Skipping this interaction is unavailable.": "skipUnavailable",
    "Queue reordering is unavailable.": "reorderUnavailable",
    "Steering is unavailable.": "steerUnavailable",
    "Discard is unavailable.": "discardUnavailable",
  };
  return keys[value] ? t(`localizationTaskThread.${keys[value]}`) : value;
}

/** Never alter marker.label in the model: retry eligibility compares "Run failed". */
export function taskThreadMarkerDetailDisplay(value: string): string {
  const addedKeys: Readonly<Record<string, string>> = {
    "Earlier messages and files are still available.": "sep12Chat.marker.earlierMessagesAvailable",
    "This turn was cancelled before it returned a response.": "sep12Chat.marker.cancelledBeforeResponse",
    "The previous execution needs to be checked before work can continue. See the task’s execution hold for the next action. Individual checks remain in the run history.": "sep12Chat.marker.executionCheckRequired",
  };
  if (addedKeys[value]) return t(addedKeys[value]);
  const exact: Readonly<Record<string, string>> = {
    "The run was cancelled before returning an answer.": "cancelledBefore",
    "The run was cancelled after returning a final response.": "cancelledAfter",
    "The run was interrupted before returning an answer.": "interruptedBefore",
    "The run was interrupted after returning a final response.": "interruptedAfter",
    "Provider output exceeded the safe limit.": "providerLimit",
    "The provider rejected the selected model. Check the model ID and your account's access, save the agent configuration, then retry. View the run for the provider's full error.": "providerModelRejected",
    "The model provider has reached its current usage limit. Try again after the limit resets.": "providerUsageLimit",
    "Provider output exceeded the safe limit. Retry scheduled automatically.": "providerLimitRetryScheduled",
    "Provider output exceeded the safe limit. You can retry this message now.": "providerLimitRetryNow",
    "The runner returned no user-facing response.": "noResponse",
  };
  if (exact[value]) return t(`localizationTaskThread.${exact[value]}`);
  const match = /^The runner (timed out|stopped) (before returning an answer|after returning a final response) \((.+)\)\.(?: (Retry scheduled automatically\.|You can retry this message now\.))?$/.exec(value);
  if (!match) return value;
  const action = match[1] === "timed out" ? "timeout" : "stopped";
  const boundary = match[2] === "before returning an answer" ? "Before" : "After";
  const retry = match[4] === "Retry scheduled automatically." ? "RetryScheduled" : match[4] ? "RetryNow" : "";
  if (retry && (action !== "stopped" || boundary !== "Before")) return value;
  return t(`localizationTaskThread.${action}${boundary}${retry}`, { code: match[3] });
}

export function taskThreadResourceDisplay(item: TaskChatMaterializedResourceItem): { title: string; subtitle: string } {
  if (item.resourceKind === "document") {
    const revision = /^Document · rev (\d+)$/.exec(item.subtitle);
    return { title: item.title, subtitle: revision ? t("localizationTaskThread.documentRevision", { revision: revision[1] }) : item.subtitle };
  }
  if (item.resourceKind === "attachment" && item.attachment) {
    const attachment = item.attachment;
    const bytes = attachment.byteSize;
    const size = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024);
    const unit = bytes < 1024 ? "bytes" : bytes < 1024 * 1024 ? "kilobytes" : "megabytes";
    const formatted = new Intl.NumberFormat(i18n.resolvedLanguage, { useGrouping: false, minimumFractionDigits: bytes < 1024 ? 0 : 1, maximumFractionDigits: bytes < 1024 ? 0 : 1 }).format(size);
    return {
      title: attachment.originalFilename ?? t("localizationTaskThread.agentAttachment"),
      subtitle: `${attachment.contentType} · ${t(`localizationIssueDetail.${unit}`, { size: formatted })}`,
    };
  }
  return { title: item.title, subtitle: item.subtitle };
}

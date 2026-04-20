declare module 'markdown-it-task-lists' {
  import type { PluginSimple, PluginWithOptions } from 'markdown-it';

  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  const taskLists: PluginWithOptions<TaskListsOptions> | PluginSimple;
  export default taskLists;
}

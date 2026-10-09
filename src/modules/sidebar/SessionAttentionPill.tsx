import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { SessionAttention } from '@/shared/types';

type SessionAttentionPillProps = {
  attention: SessionAttention;
  t: TFunction;
};

/** Rendered by SidebarSessionItem and SidebarRecentConversations beside the title of a session the server marked. */
export default function SessionAttentionPill({ attention, t }: SessionAttentionPillProps) {
  return (
    <span
      data-testid="session-attention-pill"
      className={cn(
        'flex-shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4',
        attention === 'input'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-green-500/15 text-green-700 dark:text-green-300',
      )}
    >
      {attention === 'input' ? t('attention.input', 'Needs input') : t('attention.done', 'Done')}
    </span>
  );
}

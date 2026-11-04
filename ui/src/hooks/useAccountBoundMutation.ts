import { useCallback, useContext } from "react";
import {
  useMutation,
  useQueryClient,
  QueryClientContext,
  type DefaultError,
  type MutateOptions,
  type UseMutationOptions,
  type UseMutationResult,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import { PendingSendAccountChangedError } from "@/lib/pending-send";
import { bindAccount } from "@/lib/account-scope";

export function useCurrentAccountGuard(): () => boolean {
  const client = useContext(QueryClientContext);
  return client ? bindAccount(client).isCurrentAccount : () => true;
}

type AccountMutationContext = MutationFunctionContext & { assertCurrentAccount: () => void };

export function useAccountBoundMutation<TData = unknown, TError = DefaultError, TVariables = void, TContext = unknown>(
  options: Omit<UseMutationOptions<TData, TError, TVariables, TContext>, "mutationFn"> & {
    mutationFn?: (variables: TVariables, context: AccountMutationContext) => Promise<TData>;
    waitForTurn?: (variables: TVariables) => Promise<void> | undefined;
    onFinished?: (variables: NoInfer<TVariables>, context: NoInfer<TContext> | undefined) => void;
  },
): UseMutationResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient();
  type OwnedVariables = { input: TVariables; operation: typeof options } & ReturnType<typeof bindAccount>;
  const { mutationFn, onMutate, onSuccess, onError, onSettled, waitForTurn, onFinished, ...rest } = options;
  const mutation = useMutation<TData, TError, OwnedVariables, TContext | undefined>({
    ...rest,
    mutationFn: async ({ input, isCurrentAccount, whenAccountReady, operation }, context) => {
      await whenAccountReady();
      await operation.waitForTurn?.(input);
      const assertCurrentAccount = () => {
        if (!isCurrentAccount()) {
          const error = new PendingSendAccountChangedError();
          error.name = "AbortError";
          throw error;
        }
      };
      assertCurrentAccount();
      if (!operation.mutationFn) throw new Error("Missing account-bound mutation function");
      const result = await operation.mutationFn(input, { ...context, assertCurrentAccount });
      assertCurrentAccount();
      return result;
    },
    onMutate: async ({ input, isCurrentAccount, whenAccountReady, operation }, context) => {
      await whenAccountReady();
      return isCurrentAccount() ? operation.onMutate?.(input, context) : undefined;
    },
    onSuccess: (data, { input, isCurrentAccount, operation }, result, context) => isCurrentAccount() ? operation.onSuccess?.(data, input, result as TContext, context) : undefined,
    onError: (error, { input, isCurrentScope, operation }, result, context) => isCurrentScope() ? operation.onError?.(error, input, result, context) : undefined,
    onSettled: async (data, error, { input, operation, isCurrentScope }, result, context) => {
      operation.onFinished?.(input, result);
      if (isCurrentScope()) await operation.onSettled?.(data, error, input, result, context);
    },
  });
  const wrapOptions = (callbacks?: MutateOptions<TData, TError, TVariables, TContext>): MutateOptions<TData, TError, OwnedVariables, TContext | undefined> => ({
    onSuccess: (data, { input, isCurrentAccount }, result, context) => { if (isCurrentAccount()) callbacks?.onSuccess?.(data, input, result, context); },
    onError: (error, { input, isCurrentScope }, result, context) => { if (isCurrentScope()) callbacks?.onError?.(error, input, result, context); },
    onSettled: (data, error, { input, isCurrentScope }, result, context) => { if (isCurrentScope()) callbacks?.onSettled?.(data, error, input, result, context); },
  });
  const mutate = useCallback((input: TVariables, callbacks?: MutateOptions<TData, TError, TVariables, TContext>) => {
    mutation.mutate({ input, ...bindAccount(client), operation: options }, wrapOptions(callbacks));
  }, [client, mutation.mutate, options]);
  const mutateAsync = useCallback((input: TVariables, callbacks?: MutateOptions<TData, TError, TVariables, TContext>) => {
    return mutation.mutateAsync({ input, ...bindAccount(client), operation: options }, wrapOptions(callbacks));
  }, [client, mutation.mutateAsync, options]);
  return { ...mutation, variables: mutation.variables?.input, mutate, mutateAsync } as UseMutationResult<TData, TError, TVariables, TContext>;
}

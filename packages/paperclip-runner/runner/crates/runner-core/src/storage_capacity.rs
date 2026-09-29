//! A bounded, synchronous write can wait for capacity without unwinding its
//! command/effect stack. The owning runner supplies a control-only callback;
//! storage-only callers without one still receive the original error promptly.
use crate::durable::DurableRunnerError;
use std::{cell::RefCell, rc::Rc};

type Result<T> = std::result::Result<T, DurableRunnerError>;
type Callback = Box<dyn FnMut() -> Result<()>>;

/// Use only for an idempotent storage step or an exact token-bound commit.
/// Never wrap a provider/business operation in this retry helper.
pub(crate) fn retry<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    loop {
        check_cancelled()?;
        match operation() {
            Err(error) if wait(&error)? => continue,
            result => return result,
        }
    }
}
struct Waiter {
    callback: RefCell<Callback>,
    cancelled: RefCell<Option<DurableRunnerError>>,
}
thread_local! { static CURRENT: RefCell<Option<Rc<Waiter>>> = const { RefCell::new(None) }; }

/// The callback owns its transport state, so no borrowed pointer or unsafe
/// lifetime extension crosses this scope. Drop restores the prior scope even
/// when an operation panics. A child storage thread never inherits this hook.
pub(crate) fn with_wait<T>(
    callback: impl FnMut() -> Result<()> + 'static,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    struct Restore(Option<Rc<Waiter>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let waiter = Rc::new(Waiter {
        callback: RefCell::new(Box::new(callback)),
        cancelled: RefCell::new(None),
    });
    let _restore = Restore(CURRENT.with(|slot| slot.replace(Some(waiter.clone()))));
    let result = operation();
    let cancelled = waiter.cancelled.borrow().clone();
    match cancelled {
        Some(error) => Err(error),
        None => result,
    }
}

pub(crate) fn check_cancelled() -> Result<()> {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|waiter| waiter.cancelled.borrow().clone())
            .map_or(Ok(()), Err)
    })
}

pub(crate) fn wait(error: &DurableRunnerError) -> Result<bool> {
    check_cancelled()?;
    if !error.is_storage_capacity() {
        return Ok(false);
    }
    let waiter = CURRENT.with(|slot| slot.borrow().clone());
    let Some(waiter) = waiter else {
        return Ok(false);
    };
    let result = waiter.callback.borrow_mut()();
    match result {
        Ok(()) => Ok(true),
        Err(error) => {
            let error = DurableRunnerError::storage_wait_cancelled(format!(
                "storage_pressure: control wait stopped: {error}"
            ));
            *waiter.cancelled.borrow_mut() = Some(error.clone());
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_physical_capacity_retries_and_cancel_is_sticky() {
        let full = DurableRunnerError::storage_capacity("full");
        assert!(!wait(&full).unwrap());
        with_wait(
            || Ok(()),
            || {
                assert!(wait(&full)?);
                assert!(!wait(&DurableRunnerError::invalid(
                    "storage_pressure: record bound"
                ))?);
                let result = with_wait(
                    || Err(DurableRunnerError::invalid("revoked")),
                    || {
                        assert!(wait(&full).unwrap_err().is_storage_wait_cancelled());
                        assert!(check_cancelled().is_err());
                        Ok(())
                    },
                );
                assert!(result.is_err());
                assert!(wait(&full)?);
                Ok(())
            },
        )
        .unwrap();
        assert!(!wait(&full).unwrap());
    }
    #[test]
    fn panic_does_not_leak_a_callback() {
        let _ =
            std::panic::catch_unwind(|| with_wait(|| Ok(()), || -> Result<()> { panic!("test") }));
        assert!(!wait(&DurableRunnerError::storage_capacity("full")).unwrap());
    }
}

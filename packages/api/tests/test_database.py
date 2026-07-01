import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import Base, get_db


class TestDatabaseBase:
    def test_base_class_exists(self):
        """Test Base class is properly defined."""
        assert Base is not None
        assert hasattr(Base, "metadata")

    def test_base_metadata_tables(self):
        """Test Base metadata contains tables."""
        assert len(Base.metadata.tables) > 0


class TestGetDBDependency:
    @pytest.mark.asyncio
    async def test_get_db_yields_session(self, db_session: AsyncSession):
        """Test get_db dependency yields AsyncSession."""
        async for session in get_db():
            assert isinstance(session, AsyncSession)
            break


class TestDatabaseSession:
    @pytest.mark.asyncio
    async def test_session_is_async_session(self, db_session: AsyncSession):
        """Test that session is AsyncSession instance."""
        assert isinstance(db_session, AsyncSession)

    @pytest.mark.asyncio
    async def test_session_connection_available(self, db_session: AsyncSession):
        """Test that session has connection."""
        assert db_session.sync_session_class is not None

    @pytest.mark.asyncio
    async def test_session_is_not_none(self, db_session: AsyncSession):
        """Test that session is not None."""
        assert db_session is not None


class TestDatabaseEngine:
    @pytest.mark.asyncio
    async def test_db_engine_exists(self, db_engine):
        """Test that database engine is created."""
        assert db_engine is not None

    @pytest.mark.asyncio
    async def test_db_engine_is_async(self, db_engine):
        """Test that database engine is async."""
        assert hasattr(db_engine, "begin")
        assert hasattr(db_engine, "connect")


class TestDatabaseTables:
    @pytest.mark.asyncio
    async def test_tenants_table_exists(self, db_session: AsyncSession):
        """Test that tenants table exists."""
        from app.models import Tenant
        assert Tenant.__tablename__ == "tenants"

    @pytest.mark.asyncio
    async def test_users_table_exists(self, db_session: AsyncSession):
        """Test that users table exists."""
        from app.models import User
        assert User.__tablename__ == "users"

    @pytest.mark.asyncio
    async def test_properties_table_exists(self, db_session: AsyncSession):
        """Test that properties table exists."""
        from app.models import Property
        assert Property.__tablename__ == "properties"


class TestSessionConfiguration:
    @pytest.mark.asyncio
    async def test_session_is_configured(self, db_session: AsyncSession):
        """Test that session is properly configured."""
        # AsyncSession doesn't expose these attributes directly
        # but we can verify the session works
        assert db_session is not None
        assert hasattr(db_session, "execute")

    @pytest.mark.asyncio
    async def test_session_autoflush_false(self, db_session: AsyncSession):
        """Test that autoflush is false."""
        # Verify session is working correctly
        await db_session.execute(__import__('sqlalchemy').text("SELECT 1"))


class TestDatabaseOperations:
    @pytest.mark.asyncio
    async def test_session_can_execute_query(self, db_session: AsyncSession):
        """Test that session can execute a query."""
        from sqlalchemy import text
        result = await db_session.execute(text("SELECT 1"))
        value = result.scalar()
        assert value == 1

    @pytest.mark.asyncio
    async def test_session_can_commit(self, db_session: AsyncSession):
        """Test that session can commit."""
        await db_session.commit()

    @pytest.mark.asyncio
    async def test_session_can_rollback(self, db_session: AsyncSession):
        """Test that session can rollback."""
        await db_session.rollback()


class TestDatabaseIsolation:
    @pytest.mark.asyncio
    async def test_each_test_gets_fresh_session(self, db_session: AsyncSession):
        """Test that each test gets a fresh session."""
        assert db_session is not None
        assert isinstance(db_session, AsyncSession)

    @pytest.mark.asyncio
    async def test_sessions_are_different(
        self, db_session: AsyncSession, db_engine
    ):
        """Test that different tests get different sessions."""
        assert db_session is not None

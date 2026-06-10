import uuid
from datetime import datetime
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tenant, User, Property, Base


class TestTenantModel:
    def test_tenant_tablename(self):
        """Test Tenant table name."""
        assert Tenant.__tablename__ == "tenants"

    def test_tenant_has_id_column(self):
        """Test Tenant has id column."""
        assert hasattr(Tenant, "id")

    def test_tenant_has_name_column(self):
        """Test Tenant has name column."""
        assert hasattr(Tenant, "name")

    def test_tenant_has_slug_column(self):
        """Test Tenant has slug column."""
        assert hasattr(Tenant, "slug")

    def test_tenant_has_plan_column(self):
        """Test Tenant has plan column."""
        assert hasattr(Tenant, "plan")

    def test_tenant_has_created_at_column(self):
        """Test Tenant has created_at column."""
        assert hasattr(Tenant, "created_at")

    def test_tenant_has_updated_at_column(self):
        """Test Tenant has updated_at column."""
        assert hasattr(Tenant, "updated_at")

    def test_tenant_has_users_relationship(self):
        """Test Tenant has users relationship."""
        assert hasattr(Tenant, "users")

    def test_tenant_has_properties_relationship(self):
        """Test Tenant has properties relationship."""
        assert hasattr(Tenant, "properties")

    @pytest.mark.asyncio
    async def test_create_tenant(self, db_session: AsyncSession):
        """Test creating a tenant."""
        tenant = Tenant(
            id=str(uuid.uuid4()),
            name="Test Tenant",
            slug="test-tenant",
            plan="pro",
        )
        db_session.add(tenant)
        await db_session.commit()
        assert tenant.id is not None
        assert tenant.name == "Test Tenant"

    @pytest.mark.asyncio
    async def test_tenant_default_plan(self, db_session: AsyncSession):
        """Test tenant defaults to free plan."""
        tenant = Tenant(
            id=str(uuid.uuid4()),
            name="Free Tenant",
            slug="free-tenant",
        )
        db_session.add(tenant)
        await db_session.commit()
        assert tenant.plan == "free"


class TestUserModel:
    def test_user_tablename(self):
        """Test User table name."""
        assert User.__tablename__ == "users"

    def test_user_has_id_column(self):
        """Test User has id column."""
        assert hasattr(User, "id")

    def test_user_has_email_column(self):
        """Test User has email column."""
        assert hasattr(User, "email")

    def test_user_has_clerk_id_column(self):
        """Test User has clerk_id column."""
        assert hasattr(User, "clerk_id")

    def test_user_has_tenant_id_column(self):
        """Test User has tenant_id column."""
        assert hasattr(User, "tenant_id")

    def test_user_has_role_column(self):
        """Test User has role column."""
        assert hasattr(User, "role")

    def test_user_has_created_at_column(self):
        """Test User has created_at column."""
        assert hasattr(User, "created_at")

    def test_user_has_updated_at_column(self):
        """Test User has updated_at column."""
        assert hasattr(User, "updated_at")

    def test_user_has_tenant_relationship(self):
        """Test User has tenant relationship."""
        assert hasattr(User, "tenant")

    @pytest.mark.asyncio
    async def test_create_user(self, db_session: AsyncSession):
        """Test creating a user."""
        user = User(
            id=str(uuid.uuid4()),
            email="test@example.com",
            clerk_id="clerk_12345",
            role="member",
        )
        db_session.add(user)
        await db_session.commit()
        assert user.id is not None
        assert user.email == "test@example.com"

    @pytest.mark.asyncio
    async def test_user_default_role(self, db_session: AsyncSession):
        """Test user defaults to member role."""
        user = User(
            id=str(uuid.uuid4()),
            email="member@example.com",
            clerk_id="clerk_member",
        )
        db_session.add(user)
        await db_session.commit()
        assert user.role == "member"

    @pytest.mark.asyncio
    async def test_user_with_tenant(
        self, db_session: AsyncSession, sample_tenant_id
    ):
        """Test creating user with tenant."""
        # First create tenant
        tenant = Tenant(
            id=sample_tenant_id,
            name="Test Org",
            slug="test-org",
        )
        db_session.add(tenant)
        await db_session.flush()

        # Create user with tenant
        user = User(
            id=str(uuid.uuid4()),
            email="orguser@example.com",
            clerk_id="clerk_org",
            tenant_id=sample_tenant_id,
        )
        db_session.add(user)
        await db_session.commit()
        assert user.tenant_id == sample_tenant_id


class TestPropertyModel:
    def test_property_tablename(self):
        """Test Property table name."""
        assert Property.__tablename__ == "properties"

    def test_property_has_id_column(self):
        """Test Property has id column."""
        assert hasattr(Property, "id")

    def test_property_has_address_column(self):
        """Test Property has address column."""
        assert hasattr(Property, "address")

    def test_property_has_city_column(self):
        """Test Property has city column."""
        assert hasattr(Property, "city")

    def test_property_has_state_column(self):
        """Test Property has state column."""
        assert hasattr(Property, "state")

    def test_property_has_zip_column(self):
        """Test Property has zip column."""
        assert hasattr(Property, "zip")

    def test_property_has_beds_column(self):
        """Test Property has beds column."""
        assert hasattr(Property, "beds")

    def test_property_has_baths_column(self):
        """Test Property has baths column."""
        assert hasattr(Property, "baths")

    def test_property_has_sqft_column(self):
        """Test Property has sqft column."""
        assert hasattr(Property, "sqft")

    def test_property_has_status_column(self):
        """Test Property has status column."""
        assert hasattr(Property, "status")

    @pytest.mark.asyncio
    async def test_create_property(
        self, db_session: AsyncSession, sample_tenant_id
    ):
        """Test creating a property."""
        # Create tenant first
        tenant = Tenant(
            id=sample_tenant_id,
            name="Test Tenant",
            slug="test-prop-tenant",
        )
        db_session.add(tenant)
        await db_session.flush()

        # Create property
        property_obj = Property(
            id=str(uuid.uuid4()),
            tenant_id=sample_tenant_id,
            address="123 Main St",
            city="Houston",
            state="TX",
            zip="77001",
            beds=3,
            baths=2.0,
            sqft=1500,
            property_type="Single Family",
        )
        db_session.add(property_obj)
        await db_session.commit()
        assert property_obj.id is not None
        assert property_obj.address == "123 Main St"

    @pytest.mark.asyncio
    async def test_property_default_status(
        self, db_session: AsyncSession, sample_tenant_id
    ):
        """Test property defaults to active status."""
        tenant = Tenant(
            id=sample_tenant_id,
            name="Test Tenant",
            slug="test-status-tenant",
        )
        db_session.add(tenant)
        await db_session.flush()

        property_obj = Property(
            id=str(uuid.uuid4()),
            tenant_id=sample_tenant_id,
            address="456 Oak Ave",
            city="Houston",
            state="TX",
            zip="77002",
        )
        db_session.add(property_obj)
        await db_session.commit()
        assert property_obj.status == "active"


class TestModelUUID:
    def test_uuid_generation(self):
        """Test UUID generation in models."""
        id1 = str(uuid.uuid4())
        id2 = str(uuid.uuid4())
        assert id1 != id2
        assert len(id1) == 36  # Standard UUID length


class TestModelTimestamps:
    @pytest.mark.asyncio
    async def test_tenant_timestamps(self, db_session: AsyncSession):
        """Test tenant timestamps are set."""
        tenant = Tenant(
            id=str(uuid.uuid4()),
            name="Timestamp Test",
            slug="timestamp-test",
        )
        db_session.add(tenant)
        await db_session.commit()
        assert tenant.created_at is not None
        assert tenant.updated_at is not None

    @pytest.mark.asyncio
    async def test_user_timestamps(self, db_session: AsyncSession):
        """Test user timestamps are set."""
        user = User(
            id=str(uuid.uuid4()),
            email="timestamp@example.com",
            clerk_id="clerk_timestamp",
        )
        db_session.add(user)
        await db_session.commit()
        assert user.created_at is not None
        assert user.updated_at is not None


class TestBaseMetadata:
    def test_base_has_metadata(self):
        """Test Base has metadata."""
        assert hasattr(Base, "metadata")

    def test_base_metadata_has_tables(self):
        """Test Base metadata contains table definitions."""
        assert len(Base.metadata.tables) >= 2
